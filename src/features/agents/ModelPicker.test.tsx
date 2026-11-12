// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { StrictMode, useState } from "react";
import { ModelPicker, type ModelChoice } from "./ModelPicker";
import {
  DeepSeekLogoIcon,
  GrokLogoIcon,
  ZaiLogoIcon,
  KimiLogoIcon,
  ClaudeLogoIcon,
  CodexLogoIcon,
  GoogleLogoIcon,
} from "../../shared/design-system/icons";

afterEach(cleanup);

it.each([
  ["Gemini 3 Pro", "Gemini", GoogleLogoIcon],
  ["Claude Sonnet 5", "Claude", ClaudeLogoIcon],

  ["Fable 5.2", "Claude", ClaudeLogoIcon],
  ["GPT-6", "OpenAI", CodexLogoIcon],
] as const)(
  "matches the selected %s icon to its family submenu with an opaque catalog ID",
  async (label, family, Icon) => {
    const user = userEvent.setup();
    const reference = render(<Icon size={20} />);
    const artwork = reference.container.querySelector("svg")?.innerHTML;
    reference.unmount();
    render(
      <ModelPicker
        groupByFamily
        includeDefault={false}
        models={[{ id: "opaque-catalog-id", label }]}
        value="opaque-catalog-id"
        defaultLabel="Choose model"
        onChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: /^Model:/ });
    expect(trigger.querySelector("svg")?.innerHTML).toBe(artwork);
    expect(trigger.querySelector(".buzz-select-leading")).toContainElement(
      trigger.querySelector("svg"),
    );
    await user.click(trigger);
    const submenu = await screen.findByRole("menuitem", { name: family });
    expect(submenu.querySelector("svg")?.innerHTML).toBe(artwork);
  },
);

it.each([
  ["DeepSeek", "deepseek/deepseek-v3", DeepSeekLogoIcon],
  ["Grok", "xai/grok-4", GrokLogoIcon],
  ["GLM", "zhipu/glm-4.6", ZaiLogoIcon],
  ["Kimi", "moonshot/kimi-k2", KimiLogoIcon],
] as const)(
  "uses the %s mark for catalog families and inferred model IDs",
  async (family, modelId, Icon) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const reference = render(<Icon size={20} />);
    const artwork = reference.container.querySelector("svg")?.innerHTML;
    function Picker() {
      const [value, setValue] = useState("opaque-catalog-id");
      return (
        <ModelPicker
          groupByFamily
          includeDefault={false}
          models={[
            { id: "opaque-catalog-id", label: "Catalog model", family },
            { id: modelId, label: "Provider model" },
          ]}
          value={value}
          defaultLabel="Choose model"
          onChange={(id) => {
            onChange(id);
            setValue(id);
          }}
        />
      );
    }
    render(<Picker />);
    const trigger = screen.getByRole("button", { name: /^Model:/ });
    expect(trigger.querySelector("svg")?.innerHTML).toBe(artwork);
    await user.click(trigger);
    const submenu = await screen.findByRole("menuitem", { name: family });
    expect(submenu.querySelector("svg")?.innerHTML).toBe(artwork);
    submenu.focus();
    await user.keyboard("{ArrowRight}");
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Provider model" }),
    );
    expect(onChange).toHaveBeenCalledExactlyOnceWith(modelId);
    expect(trigger.querySelector("svg")?.innerHTML).toBe(artwork);
  },
);

it("lists fast models in their own section and marks them with a bolt", async () => {
  const user = userEvent.setup();
  render(
    <ModelPicker
      groupByFamily
      includeDefault={false}
      models={[
        { id: "kimi-cerebras", label: "Kimi K3.1 Pro", fast: true },
        { id: "kimi-hosted", label: "Kimi K3" },
        { id: "glm-flash", label: "GLM 5.3 Flash", fast: true },
        { id: "sonnet", label: "Claude Sonnet" },
      ]}
      value="kimi-cerebras"
      defaultLabel="Choose model"
      onChange={vi.fn()}
    />,
  );
  const trigger = screen.getByRole("button", {
    name: "Model: Kimi K3.1 Pro · Fast",
  });
  expect(within(trigger).getByTitle("Fast")).toBeInTheDocument();
  await user.click(trigger);
  const fast = await screen.findByRole("group", { name: "Fast" });
  expect(
    within(fast)
      .getAllByRole("menuitemradio")
      .map((item) => item.textContent),
  ).toEqual(["Kimi K3.1 Pro", "GLM 5.3 Flash"]);
  const submenu = screen.getByRole("menuitem", { name: "Kimi" });
  submenu.focus();
  await user.keyboard("{ArrowRight}");
  const kimi = await screen.findByRole("menu", { name: "Kimi models" });
  expect(
    within(kimi).getByRole("menuitemradio", { name: "Kimi K3.1 Pro Fast" }),
  ).toBeInTheDocument();
  expect(
    within(kimi).getByRole("menuitemradio", { name: "Kimi K3" }),
  ).not.toHaveTextContent("Fast");
});

it.each([
  ["no model is fast", false],
  ["every model is fast", true],
])("leaves out the Fast section when %s", async (_, fast) => {
  const user = userEvent.setup();
  render(
    <ModelPicker
      groupByFamily
      includeDefault={false}
      models={[
        { id: "kimi-cerebras", label: "Kimi K3.1 Pro", fast },
        { id: "glm-flash", label: "GLM 5.3 Flash", fast },
      ]}
      value="kimi-cerebras"
      defaultLabel="Choose model"
      onChange={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /^Model:/ }));
  await screen.findByRole("menuitem", { name: "Kimi" });
  expect(screen.queryByRole("group", { name: "Fast" })).toBeNull();
});

const models: ModelChoice[] = [
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus", description: "Most capable" },
];

function setup(value = "", props: { allowCustomModel?: boolean } = {}) {
  const onChange = vi.fn();
  const view = render(
    <ModelPicker
      models={models}
      allowCustomModel={props.allowCustomModel ?? true}
      value={value}
      defaultLabel="Default model"
      onChange={onChange}
    />,
  );
  return { onChange, view, user: userEvent.setup() };
}

const control = () => screen.getByRole("combobox", { name: "Model" });

it("keeps mixed-vendor options aligned without an unknown trigger icon", async () => {
  const user = userEvent.setup();
  render(
    <ModelPicker
      models={[
        { id: "opaque", label: "Unknown vendor" },
        { id: "claude", label: "Claude" },
      ]}
      value="opaque"
      defaultLabel="Choose model"
      includeDefault={false}
      onChange={vi.fn()}
    />,
  );
  expect(control().querySelector(".buzz-select-leading")).toBeNull();
  await user.click(control());
  const unknown = await screen.findByRole("option", { name: "Unknown vendor" });
  expect(unknown.querySelector(".buzz-select-leading")).toBeEmptyDOMElement();
  expect(
    screen
      .getByRole("option", { name: "Claude" })
      .querySelector(".buzz-select-leading svg"),
  ).toBeInTheDocument();
});

it("shows the Claude mark for a Fable model whose ID omits claude", () => {
  const reference = render(<ClaudeLogoIcon size={20} />);
  const artwork = reference.container.querySelector("svg")?.innerHTML;
  reference.unmount();
  render(
    <ModelPicker
      models={[{ id: "fable", label: "Fable 5.2" }]}
      value="fable"
      defaultLabel="Choose model"
      includeDefault={false}
      onChange={vi.fn()}
    />,
  );
  expect(control().querySelector(".buzz-select-leading svg")?.innerHTML).toBe(
    artwork,
  );
});

it.each([false, true])(
  "omits the icon column when every model is unknown (grouped: %s)",
  async (groupByFamily) => {
    const user = userEvent.setup();
    render(
      <ModelPicker
        groupByFamily={groupByFamily}
        models={[{ id: "opaque", label: "Unknown vendor" }]}
        value="opaque"
        defaultLabel="Provider default"
        onChange={vi.fn()}
      />,
    );
    const trigger = groupByFamily
      ? screen.getByRole("button", { name: /^Model:/ })
      : control();
    expect(trigger.querySelector(".buzz-select-leading")).toBeNull();
    await user.click(trigger);
    if (groupByFamily) {
      const family = await screen.findByRole("menuitem", { name: "Other" });
      expect(family.querySelector(".buzz-select-leading")).toBeNull();
      expect(
        family.querySelector("svg:not(.buzz-menu-submenu-arrow)"),
      ).toBeNull();
      expect(
        screen
          .getByRole("menuitemradio", { name: "Provider default · Default" })
          .querySelector(".buzz-select-leading"),
      ).toBeNull();
    } else {
      for (const option of await screen.findAllByRole("option")) {
        expect(option.querySelector(".buzz-select-leading")).toBeNull();
      }
    }
  },
);

it("aligns mixed family rows with empty slots rather than generic icons", async () => {
  const user = userEvent.setup();
  render(
    <ModelPicker
      groupByFamily
      models={[
        { id: "opaque", label: "Unknown vendor" },
        { id: "claude", label: "Claude" },
      ]}
      value="opaque"
      defaultLabel="Provider default"
      onChange={vi.fn()}
    />,
  );
  const trigger = screen.getByRole("button", { name: /^Model:/ });
  expect(trigger.querySelector(".buzz-select-leading")).toBeNull();
  await user.click(trigger);
  expect(
    (await screen.findByRole("menuitem", { name: "Other" })).querySelector(
      ".buzz-select-leading",
    ),
  ).toBeEmptyDOMElement();
  expect(
    screen
      .getByRole("menuitem", { name: "Claude" })
      .querySelector(".buzz-select-leading svg"),
  ).toBeInTheDocument();
  expect(
    screen
      .getByRole("menuitemradio", { name: "Provider default · Default" })
      .querySelector(".buzz-select-leading"),
  ).toBeEmptyDOMElement();
});

it("picks a listed model", async () => {
  const { onChange, user } = setup("");
  await user.click(control());
  await user.click(await screen.findByRole("option", { name: /Sonnet/ }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("sonnet");
});

it("picks the default as an empty value", async () => {
  const { onChange, user } = setup("opus");
  await user.click(control());
  await user.click(
    await screen.findByRole("option", { name: /Default model/ }),
  );
  expect(onChange).toHaveBeenCalledExactlyOnceWith("");
});

it.each([
  [true, "Custom model"],
  [false, "Unavailable model"],
])(
  "describes a saved unlisted value when custom entry is %s",
  async (allowCustomModel, description) => {
    const { user } = setup("claude-old-1", { allowCustomModel });
    expect(control()).toHaveTextContent("claude-old-1");
    await user.click(control());
    const option = await screen.findByRole("option", { name: /claude-old-1/ });
    expect(option).toHaveTextContent(description);
    expect(option).toHaveAttribute("aria-selected", "true");
  },
);

it("does not submit a form around the custom-model dialog", async () => {
  const submitted = vi.fn();
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitted();
      }}
    >
      <ModelPicker
        models={models}
        allowCustomModel
        value=""
        defaultLabel="Default model"
        onChange={onChange}
      />
    </form>,
  );
  await user.click(control());
  await user.click(await screen.findByRole("option", { name: "Custom model" }));
  await user.type(
    await screen.findByRole("textbox", { name: "Model ID" }),
    "claude-custom-1{enter}",
  );
  expect(onChange).toHaveBeenCalledExactlyOnceWith("claude-custom-1");
  expect(submitted).not.toHaveBeenCalled();
});

it("uses a dropdown to pick listed models when custom entry is disabled", async () => {
  const { onChange, user } = setup("", { allowCustomModel: false });
  expect(control().tagName).toBe("BUTTON");
  expect(control()).toHaveTextContent("Default model");
  await user.click(control());
  expect(
    screen.queryByRole("option", { name: "Custom model" }),
  ).not.toBeInTheDocument();
  await user.click(await screen.findByRole("option", { name: /Opus/ }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("opus");
});

it("edits a custom model in a dialog without changing the selection on cancel", async () => {
  const { onChange, user } = setup("opus");
  await user.click(control());
  const custom = await screen.findByRole("option", { name: "Custom model" });
  expect(custom).toHaveAccessibleDescription("Enter a model ID");
  await user.click(custom);
  expect(
    await screen.findByRole("dialog", { name: "Custom model" }),
  ).toBeVisible();
  const modelId = screen.getByRole("textbox", { name: "Model ID" });
  await waitFor(() => expect(modelId).toHaveFocus());
  expect(onChange).not.toHaveBeenCalled();
  await user.type(modelId, "ignored-model");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog", { name: "Custom model" })).toBeNull();
  expect(control()).toHaveTextContent("Opus");
  await user.click(control());
  await user.click(await screen.findByRole("option", { name: "Custom model" }));
  await user.type(
    await screen.findByRole("textbox", { name: "Model ID" }),
    "  claude-custom-1  ",
  );
  await user.click(screen.getByRole("button", { name: "Use model" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("claude-custom-1");
});

it("is disabled as a whole", () => {
  render(
    <ModelPicker
      models={models}
      allowCustomModel
      value=""
      defaultLabel="Default model"
      onChange={vi.fn()}
      disabled
    />,
  );
  expect(control()).toBeDisabled();
});

it("keeps loading inside the disabled picker and restores the selected value", () => {
  const onChange = vi.fn();
  const view = render(
    <ModelPicker
      models={[]}
      allowCustomModel={false}
      value=""
      defaultLabel="Default model"
      onChange={onChange}
      loading
    />,
  );
  const picker = control();
  expect(picker).toBeDisabled();
  expect(picker).toContainElement(screen.getByText("Loading models…"));
  expect(picker.querySelector(".buzz-select-leading")).toBeNull();
  view.rerender(
    <ModelPicker
      models={models}
      allowCustomModel={false}
      value="opus"
      defaultLabel="Default model"
      onChange={onChange}
    />,
  );
  expect(control()).toBe(picker);
  expect(picker).toBeEnabled();
  expect(picker).toHaveTextContent("Opus");
  expect(screen.queryByText("Loading models…")).not.toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
});

it("keeps compact choices finite and includes rich model descriptions", async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <ModelPicker
      compact
      allowCustomModel
      models={models}
      value="sonnet"
      defaultLabel="Default model"
      onChange={onChange}
    />,
  );
  await user.click(control());
  expect(
    screen.queryByRole("option", { name: "Custom model" }),
  ).not.toBeInTheDocument();
  expect(await screen.findByRole("option", { name: "Sonnet" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const opus = screen.getByRole("option", { name: "Opus" });
  expect(opus).toHaveAccessibleDescription("Most capable");
  await user.click(opus);
  expect(onChange).toHaveBeenCalledExactlyOnceWith("opus");
});

it("lists the inherited default once with its catalog copy", async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <ModelPicker
      models={models}
      value=""
      defaultModel="opus"
      defaultLabel="Opus"
      onChange={onChange}
    />,
  );
  expect(control()).toHaveTextContent("Opus · Default");
  expect(screen.getByTitle("Opus · Default")).toBeVisible();
  await user.click(control());
  const options = await screen.findAllByRole("option");
  expect(options).toHaveLength(2);
  expect(options[0]).toHaveAccessibleName("Opus · Default");
  expect(options[1]).toHaveAccessibleName("Sonnet");
  expect(options[0]).toHaveAccessibleDescription("Most capable");
  expect(options[0]).toHaveAttribute("aria-selected", "true");
  expect(onChange).not.toHaveBeenCalled();
  await user.click(screen.getByRole("option", { name: "Sonnet" }));
  expect(onChange).toHaveBeenCalledWith("sonnet");
});

it("keeps a matching explicit pin distinct from inheritance as defaults change", async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  const props = {
    models,
    value: "opus",
    defaultModel: "opus",
    defaultLabel: "Opus",
    onChange,
  };
  const view = render(<ModelPicker {...props} />);
  expect(control()).not.toHaveTextContent("Default");
  await user.click(control());
  const inherited = await screen.findByRole("option", {
    name: "Opus · Default",
  });
  const pinned = screen.getByRole("option", { name: "Opus" });
  expect(pinned).toHaveAttribute("aria-selected", "true");
  expect(pinned).toHaveAccessibleDescription("Most capable");
  expect(inherited).toHaveAttribute("aria-selected", "false");
  expect(onChange).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  view.rerender(
    <ModelPicker {...props} defaultModel="sonnet" defaultLabel="Sonnet" />,
  );
  expect(control()).toHaveTextContent("Opus");
  await user.click(control());
  expect(await screen.findByRole("option", { name: "Opus" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.keyboard("{Escape}");
  view.rerender(<ModelPicker {...props} />);
  await user.click(control());
  await user.click(
    await screen.findByRole("option", { name: "Opus · Default" }),
  );
  expect(onChange).toHaveBeenCalledExactlyOnceWith("");
  view.rerender(
    <ModelPicker
      {...props}
      value=""
      defaultModel="sonnet"
      defaultLabel="Sonnet"
    />,
  );
  expect(control()).toHaveTextContent("Sonnet · Default");
  await user.click(control());
  expect(
    await screen.findByRole("option", { name: "Sonnet · Default" }),
  ).toHaveAttribute("aria-selected", "true");
});

it("opens a family before selecting a model and formats only its display name", async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <ModelPicker
      groupByFamily
      modelLabelPrefixes={["databricks-", "goose-"]}
      models={[
        { id: "databricks-gpt-6", label: "databricks-gpt-6" },
        { id: "databricks-gpt-6-codex", label: "databricks-gpt-6-codex" },
        { id: "databricks-kimi-k2", label: "databricks-kimi-k2" },
        { id: "unrecognized-model", label: "unrecognized-model" },
      ]}
      value="databricks-gpt-6"
      defaultLabel="Provider default"
      onChange={onChange}
    />,
  );
  const trigger = screen.getByRole("button", { name: /^Model:/ });
  expect(trigger).toHaveTextContent("GPT-6");
  expect(trigger).not.toHaveTextContent("databricks-");
  await user.click(trigger);
  expect(screen.queryByRole("menuitemradio", { name: "Kimi K2" })).toBeNull();
  expect(await screen.findByRole("menuitem", { name: "OpenAI" })).toBeVisible();
  expect(screen.queryByRole("menuitem", { name: "Codex" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "GPT" })).toBeNull();
  expect(screen.getByRole("menuitem", { name: "Other" })).toBeVisible();
  screen.getByRole("menuitem", { name: "OpenAI" }).focus();
  await user.keyboard("{ArrowRight}");
  expect(
    await screen.findByRole("menuitemradio", { name: "GPT-6" }),
  ).toBeVisible();
  await user.click(
    await screen.findByRole("menuitemradio", { name: "GPT-6 Codex" }),
  );
  expect(onChange).toHaveBeenCalledExactlyOnceWith("databricks-gpt-6-codex");
});

it("keeps the IDs of Databricks models whose names read the same", async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  const ids = [
    "system.ai.gpt-6-1-sol",
    "acme_models.goose.goose-gpt-6-1-sol",
    "system.ai.gpt-6-luna",
  ];
  render(
    <ModelPicker
      groupByFamily
      modelLabelPrefixes={["databricks-", "goose-"]}
      models={ids.map((id) => ({ id, label: id }))}
      value=""
      defaultLabel="acme_models.goose.goose-gpt-6-1-sol"
      onChange={onChange}
    />,
  );
  await user.click(
    screen.getByRole("button", {
      name: "Model: acme_models.goose.goose-gpt-6-1-sol · Default",
    }),
  );
  (await screen.findByRole("menuitem", { name: "OpenAI" })).focus();
  await user.keyboard("{ArrowRight}");
  expect(
    await screen.findByRole("menuitemradio", { name: "GPT-6 Luna" }),
  ).toBeVisible();
  await user.click(
    screen.getByRole("menuitemradio", { name: "system.ai.gpt-6-1-sol" }),
  );
  expect(onChange).toHaveBeenCalledExactlyOnceWith("system.ai.gpt-6-1-sol");
});

it("marks a saved model the list lacks in the family menu", async () => {
  const user = userEvent.setup();
  render(
    <ModelPicker
      groupByFamily
      allowCustomModel
      modelLabelPrefixes={["databricks-", "goose-"]}
      models={[
        {
          id: "acme_models.goose.goose-gpt-6-luna",
          label: "acme_models.goose.goose-gpt-6-luna",
        },
      ]}
      value="system.ai.gpt-6-1-sol"
      defaultLabel="Provider default"
      onChange={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Model: GPT-6.1 Sol" }));
  (await screen.findByRole("menuitem", { name: "OpenAI" })).focus();
  await user.keyboard("{ArrowRight}");
  const saved = await screen.findByRole("menuitemradio", {
    name: "GPT-6.1 Sol · Custom model",
  });
  expect(saved).toBeChecked();
  expect(
    screen.getByRole("menuitemradio", { name: "GPT-6 Luna" }),
  ).toBeVisible();
});

it("uses a catalog-owned family for grouping and the selected model icon", async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <ModelPicker
      groupByFamily
      includeDefault={false}
      models={[
        { id: "anthropic-looking-id", label: "Sol 6.1", family: "OpenAI" },
      ]}
      value="anthropic-looking-id"
      defaultLabel="Choose model"
      onChange={onChange}
    />,
    { wrapper: StrictMode },
  );
  const trigger = screen.getByRole("button", { name: /^Model:/ });
  expect(trigger.querySelector("svg")).toHaveAttribute(
    "viewBox",
    "176 176 364 364",
  );
  await user.click(trigger);
  const family = await screen.findByRole("menuitem", { name: "OpenAI" });
  expect(screen.queryByRole("menuitem", { name: "Claude" })).toBeNull();
  family.focus();
  await user.keyboard("{ArrowRight}");
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Sol 6.1" }),
  );
  expect(onChange).toHaveBeenCalledExactlyOnceWith("anthropic-looking-id");
});

it("keeps custom entry and default selection in the family menu", async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <ModelPicker
      groupByFamily
      allowCustomModel
      models={models}
      value="sonnet"
      defaultLabel="Provider default"
      onChange={onChange}
    />,
  );
  await user.click(screen.getByRole("button", { name: /^Model:/ }));
  await user.click(
    await screen.findByRole("menuitemradio", {
      name: "Provider default · Default",
    }),
  );
  expect(onChange).toHaveBeenLastCalledWith("");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await user.click(screen.getByRole("button", { name: /^Model:/ }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Custom model" }),
  );
  await user.type(screen.getByRole("textbox"), "new-model");
  await user.click(screen.getByRole("button", { name: "Use model" }));
  expect(onChange).toHaveBeenLastCalledWith("new-model");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Model:/ })).toHaveFocus(),
  );
});

it("keeps a Default suffix beside inherited card models as defaults change", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const props = {
    compact: true,
    appearance: "glass-ghost" as const,
    models: [
      { id: "gpt-6.1-sol", label: "GPT-6.1-Sol" },
      { id: "gpt-6.1-astra", label: "GPT-6.1-Astra" },
    ],
    value: "",
    defaultLabel: "GPT-6.1-Sol",
    onChange,
  };
  const view = render(<ModelPicker {...props} />);
  expect(control()).toHaveTextContent(/^GPT-6.1-Sol · Default$/);
  expect(control().querySelector(".buzz-select-value")).toHaveTextContent(
    /^GPT-6.1-Sol$/,
  );
  expect(
    control().querySelector(".buzz-select-value-suffix"),
  ).toHaveTextContent("· Default");
  expect(screen.getByTitle("GPT-6.1-Sol · Default")).toBeVisible();
  await user.click(control());
  expect(
    await screen.findByRole("option", { name: "GPT-6.1-Sol · Default" }),
  ).toHaveAttribute("aria-selected", "true");
  await user.keyboard("{Escape}");

  view.rerender(<ModelPicker {...props} defaultLabel="GPT-6.1-Astra" />);
  expect(control()).toHaveTextContent(/^GPT-6.1-Astra · Default$/);
  expect(onChange).not.toHaveBeenCalled();

  view.rerender(<ModelPicker {...props} value="gpt-6.1-sol" />);
  expect(control()).toHaveTextContent(/^GPT-6.1-Sol$/);
  expect(control().querySelector(".buzz-select-value-suffix")).toBeNull();

  view.rerender(<ModelPicker {...props} loading />);
  expect(control()).toHaveTextContent("Loading models…");
  expect(control().querySelector(".buzz-select-value-suffix")).toBeNull();
});

it.each(["", "reasoning"])(
  "offers supported effort without changing model inheritance (%s)",
  async (value) => {
    const user = userEvent.setup();
    const onEffortChange = vi.fn();
    const props = {
      models: [
        {
          id: "reasoning",
          label: "Reasoning",
          efforts: [
            { id: "", label: "Automatic" },
            { id: "high", label: "High" },
          ],
        },
        { id: "plain", label: "Plain" },
      ],
      value,
      defaultModel: "reasoning",
      defaultLabel: "Reasoning",
      onChange: vi.fn(),
      onEffortChange,
      effort: "",
    };
    const view = render(<ModelPicker {...props} />);
    await user.click(screen.getByRole("combobox", { name: "Thinking effort" }));
    await user.click(await screen.findByRole("option", { name: "High" }));
    expect(onEffortChange).toHaveBeenCalledExactlyOnceWith(value, "high");
    view.rerender(<ModelPicker {...props} disabled />);
    expect(
      screen.getByRole("combobox", { name: "Thinking effort" }),
    ).toBeDisabled();
    view.rerender(<ModelPicker {...props} value="plain" />);
    expect(
      screen.queryByRole("combobox", { name: "Thinking effort" }),
    ).toBeNull();
  },
);
