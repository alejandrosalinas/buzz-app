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
import { SECTIONS } from "../agent-harness/sections";
import { SECTION_TEXT_BYTES } from "../agent-harness/sections/choices";
import { BaseInstructions } from "./BaseInstructions";
import {
  defaultHash,
  ownerChoices,
  ownerSections,
  PROMPT_SECTIONS_KEY,
} from "./prompt-sections";
import { fileStore } from "./state";
import { type AgentStore, localStore } from "./store";

afterEach(cleanup);

const memory = (global?: unknown) => {
  const values = new Map<string, string>();
  if (global !== undefined)
    values.set(
      PROMPT_SECTIONS_KEY,
      typeof global === "string"
        ? global
        : JSON.stringify({ version: 1, global }),
    );
  return localStore({
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  });
};
const defaultOf = (id: string) =>
  String(SECTIONS.find((section) => section.id === id)?.text).trim();
const choice = (title: string) => screen.getByRole("combobox", { name: title });
const choose = async (
  user: ReturnType<typeof userEvent.setup>,
  title: string,
  mode: string,
) => {
  await user.click(choice(title));
  await user.click(await screen.findByRole("option", { name: mode }));
};
const editor = (title: string) =>
  screen.getByRole("textbox", { name: `Your text for ${title}` });

it("shows defaults read-only and keeps the custom draft when switching modes", async () => {
  const user = userEvent.setup();
  const store = memory();
  render(<BaseInstructions store={store} />);
  for (const section of SECTIONS.filter((section) => section.owner)) {
    const preview = screen.getByRole("textbox", {
      name: `Default text for ${section.title}`,
    });
    expect(preview).toHaveValue(defaultOf(section.id));
    expect(preview).toHaveAttribute("readonly");
    expect(preview).toBeEnabled();
    expect(preview).toHaveAccessibleDescription("Choose Custom to edit.");
  }
  const preview = () =>
    screen.getByRole("textbox", { name: "Default text for Progress" });
  await user.click(preview());
  await user.keyboard("Changed");
  expect(preview()).toHaveValue(defaultOf("progress"));
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();

  await choose(user, "Progress", "Custom");
  expect(editor("Progress")).not.toHaveAttribute("readonly");
  await user.clear(editor("Progress"));
  await user.type(editor("Progress"), "Report milestones.");
  await choose(user, "Progress", "Default");
  expect(preview()).toHaveValue(defaultOf("progress"));
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  await choose(user, "Progress", "Off");
  expect(
    screen.queryByRole("textbox", { name: /text for Progress/ }),
  ).not.toBeInTheDocument();
  await choose(user, "Progress", "Custom");
  expect(editor("Progress")).toHaveValue("Report milestones.");
  expect(ownerChoices(store)).toEqual({});
});

it("offers Default, Off and Custom for each section the owner can configure", async () => {
  const user = userEvent.setup();
  render(<BaseInstructions store={memory()} />);
  for (const title of [
    "Publishing",
    "Progress",
    "Etiquette",
    "Agent Memory",
    "Commit identity",
    "Autonomy",
  ])
    expect(choice(title)).toHaveTextContent("Default");
  expect(
    screen.queryByRole("combobox", { name: "Trust" }),
  ).not.toBeInTheDocument();
  await user.click(choice("Progress"));
  expect(
    (await screen.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["Default", "Off", "Custom"]);
  await user.keyboard("{Escape}");
  // Nothing to save until a choice differs.
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText(
      "Applies to each agent from its next turn. A session that is running a turn changes when the turn ends. Agents in the standalone agent host get a change when it next starts. Mesh agents do not get the base instructions.",
    ),
  ).toBeInTheDocument();
});

it("saves a section turned off and one with the owner's text, only on Save", async () => {
  const user = userEvent.setup();
  const store = memory();
  render(<BaseInstructions store={store} />);
  await choose(user, "Progress", "Off");
  await choose(user, "Etiquette", "Custom");
  // Custom starts from the default text.
  expect(editor("Etiquette")).toHaveValue(defaultOf("etiquette"));
  await user.clear(editor("Etiquette"));
  await user.type(editor("Etiquette"), "Be brief.");
  expect(screen.getByText("9 of 4,096 bytes")).toBeInTheDocument();
  expect(
    screen.getByText(
      /^Older Codex conversations on this device start over once\./,
    ),
  ).toBeInTheDocument();
  expect(ownerChoices(store)).toEqual({});

  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(ownerChoices(store)).toEqual({
    progress: { mode: "off" },
    etiquette: { mode: "custom", text: "Be brief." },
  });
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  expect(choice("Progress")).toHaveTextContent("Off");
  expect(editor("Etiquette")).toHaveValue("Be brief.");
  // Said once, with the first choice.
  await choose(user, "Autonomy", "Off");
  expect(
    screen.queryByText(
      /^Older Codex conversations on this device start over once\./,
    ),
  ).not.toBeInTheDocument();
});

it("keeps a text that cannot be used out of the store", async () => {
  const user = userEvent.setup();
  const store = memory();
  render(<BaseInstructions store={store} />);
  await choose(user, "Etiquette", "Custom");
  await user.clear(editor("Etiquette"));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Enter the instructions, or choose Default or Off.",
  );
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await user.click(editor("Etiquette"));
  await user.paste("é".repeat(SECTION_TEXT_BYTES / 2 + 1));
  // The count stays in view when the text is too long.
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Keep the instructions within 4 KiB. 4,098 of 4,096 bytes.",
  );
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await user.clear(editor("Etiquette"));
  await user.type(editor("Etiquette"), "Short.");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  expect(ownerChoices(store)).toEqual({});
});

it("returns a section to its default with Reset, and a draft with Cancel", async () => {
  const user = userEvent.setup();
  const store = memory({
    progress: { mode: "off", basedOn: "x" },
    etiquette: { mode: "custom", text: "Be brief.", basedOn: "x" },
  });
  render(<BaseInstructions store={store} />);
  // Cancel drops the draft.
  await user.clear(editor("Etiquette"));
  await user.type(editor("Etiquette"), "Be long.");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(editor("Etiquette")).toHaveValue("Be brief.");
  // Reset to default removes the choice at Save.
  const resets = screen.getAllByRole("button", { name: "Reset to default" });
  expect(resets).toHaveLength(2);
  await user.click(resets[1] as HTMLElement);
  expect(choice("Etiquette")).toHaveTextContent("Default");
  expect(ownerChoices(store)).toHaveProperty("etiquette");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(ownerChoices(store)).toEqual({ progress: { mode: "off" } });
  // Custom text that is the default text is the default.
  await choose(user, "Etiquette", "Custom");
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
});

it("says when a default changed after the owner's choice, until they keep theirs", async () => {
  const user = userEvent.setup();
  const store = memory({
    progress: { mode: "off", basedOn: "an-older-default" },
    etiquette: {
      mode: "custom",
      text: "Be brief.",
      basedOn: ownerSectionsHash("etiquette"),
    },
  });
  render(<BaseInstructions store={store} />);
  // Only the choice made on another default says so, with the default now.
  expect(screen.getAllByText("Default changed")).toHaveLength(1);
  expect(choice("Progress")).toHaveAccessibleDescription(
    /^The default text changed after you made this choice\./,
  );
  expect(choice("Etiquette")).not.toHaveAccessibleDescription();
  expect(
    screen.getByText("The default text changed after you made this choice.", {
      exact: false,
    }).parentElement,
  ).toHaveTextContent(defaultOf("progress").slice(0, 40));
  await user.click(screen.getByRole("button", { name: "Keep mine" }));
  expect(screen.queryByText("Default changed")).not.toBeInTheDocument();
  // The button left; its section's choice has the focus.
  expect(choice("Progress")).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Save" }));
  // The choice stays; it is now based on the current default.
  expect(ownerSections(store).choices.progress).toEqual({
    mode: "off",
    basedOn: ownerSectionsHash("progress"),
  });
});

it("keeps the owner's own text when they keep theirs", async () => {
  const user = userEvent.setup();
  const store = memory({
    etiquette: { mode: "custom", text: "Be brief.", basedOn: "an-older-one" },
  });
  render(<BaseInstructions store={store} />);
  await user.click(screen.getByRole("button", { name: "Keep mine" }));
  expect(editor("Etiquette")).toHaveValue("Be brief.");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(ownerSections(store).choices.etiquette).toEqual({
    mode: "custom",
    text: "Be brief.",
    basedOn: ownerSectionsHash("etiquette"),
  });
});

it("keeps the owner's text when a later default is the same text, until they reset it", async () => {
  const user = userEvent.setup();
  // A later Buzz version made the owner's text its default.
  const etiquette = {
    mode: "custom",
    text: defaultOf("etiquette"),
    basedOn: "an-older-one",
  };
  const store = memory({ etiquette });
  render(<BaseInstructions store={store} />);
  expect(screen.getByText("Default changed")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Keep mine" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(ownerSections(store).choices.etiquette).toEqual({
    ...etiquette,
    basedOn: ownerSectionsHash("etiquette"),
  });
  // Saving another section keeps it too.
  await choose(user, "Progress", "Off");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(ownerSections(store).choices.etiquette).toMatchObject({
    mode: "custom",
  });
  await user.click(
    within(
      choice("Etiquette").closest("[data-section]") as HTMLElement,
    ).getByRole("button", { name: "Reset to default" }),
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(ownerSections(store).choices.etiquette).toBeUndefined();
});

it("lists every section's default text to read, and says who can change it", async () => {
  const user = userEvent.setup();
  render(
    <BaseInstructions
      store={memory()}
      replacedBy={(id) => (id === "working-location" ? ["Example Plugin"] : [])}
    />,
  );
  // A row's name says its title and what it is.
  const row = (name: string) => screen.getByRole("button", { name });
  for (const name of [
    "Trust, Always on",
    "Opening lines, Always on",
    "Session Model, Set by Buzz",
    "Routing, Always on",
    "Progress, You can change this",
    "Working location, Example Plugin can replace this in chats it manages.",
  ])
    expect(row(name)).toHaveTextContent(name.replace(", ", ""));
  await user.click(row("Trust, Always on"));
  expect(
    await screen.findByText(defaultOf("trust").slice(0, 60), { exact: false }),
  ).toBeInTheDocument();
  // Each row has text to read, also where Buzz picks it.
  const rows = screen
    .getAllByRole("button")
    .filter((button) => button.getAttribute("aria-expanded") === "false");
  expect(rows).toHaveLength(SECTIONS.length - 1);
  for (const closed of rows) await user.click(closed);
  for (const closed of rows)
    expect(
      document.getElementById(closed.getAttribute("aria-controls") ?? ""),
    ).not.toBeEmptyDOMElement();
  expect(
    document.getElementById(
      row("Session Model, Set by Buzz").getAttribute("aria-controls") ?? "",
    ),
  ).toHaveTextContent("You are one session of your agent identity");
});

it("warns that the owner's choice also applies in the chats a plugin manages", async () => {
  const user = userEvent.setup();
  render(
    <BaseInstructions
      store={memory()}
      replacedBy={(id) =>
        id === "progress" ? ["Example Plugin", "Other Plugin"] : []
      }
    />,
  );
  const warning =
    "Your choice also applies in chats that Example Plugin and Other Plugin manage.";
  // The default text yields to a plugin: the row names the plugins.
  expect(screen.queryByText(warning, { exact: false })).not.toBeInTheDocument();
  expect(choice("Progress")).toHaveAccessibleDescription(
    "Example Plugin and Other Plugin can replace this in chats they manage.",
  );
  await choose(user, "Progress", "Off");
  expect(screen.getByText(warning, { exact: false })).toBeInTheDocument();
  expect(screen.queryByText(/can replace this/)).not.toBeInTheDocument();
  expect(choice("Progress")).toHaveAccessibleDescription(
    expect.stringContaining(warning),
  );
  await choose(user, "Etiquette", "Off");
  expect(screen.getAllByText(/Your choice also applies/)).toHaveLength(1);
});

it("says when the saved choices cannot be read, and shows choices that are no longer used", async () => {
  const user = userEvent.setup();
  const view = render(<BaseInstructions store={memory("{not json")} />);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Your saved choices could not be read",
  );
  view.unmount();
  render(
    <BaseInstructions
      store={memory({
        "a-removed-section": { mode: "custom", text: "Mine.", basedOn: "x" },
      })}
    />,
  );
  const row = screen.getByRole("button", {
    name: "a-removed-section, no longer used",
  });
  expect(row).toHaveTextContent("No longer used");
  await user.click(row);
  expect(await screen.findByText("Mine.")).toBeInTheDocument();
});

it("keeps the draft and says why when the save fails", async () => {
  const user = userEvent.setup();
  const store = memory();
  const failing: AgentStore = {
    ...store,
    set: vi.fn(async () => {
      throw new Error("The disk is full");
    }),
  };
  render(<BaseInstructions store={failing} />);
  await choose(user, "Progress", "Off");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The disk is full",
  );
  expect(choice("Progress")).toHaveTextContent("Off");
  expect(
    within(document.body).getByRole("button", { name: "Save" }),
  ).toBeEnabled();
});

it("makes a new choice on the default as it is now", async () => {
  const user = userEvent.setup();
  const store = memory({
    progress: { mode: "off", basedOn: "an-older-default" },
  });
  render(<BaseInstructions store={store} />);
  await choose(user, "Progress", "Custom");
  expect(screen.queryByText("Default changed")).not.toBeInTheDocument();
  await user.clear(editor("Progress"));
  await user.type(editor("Progress"), "Say little.");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(ownerSections(store).choices.progress).toEqual({
    mode: "custom",
    text: "Say little.",
    basedOn: ownerSectionsHash("progress"),
  });
});

it("moves the focus to a choice when the action that had it leaves", async () => {
  const user = userEvent.setup();
  render(<BaseInstructions store={memory()} />);
  await choose(user, "Etiquette", "Off");
  await user.click(screen.getByRole("button", { name: "Reset to default" }));
  expect(choice("Etiquette")).toHaveFocus();
  await choose(user, "Etiquette", "Off");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(choice("Publishing")).toHaveFocus();
  await choose(user, "Etiquette", "Off");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(choice("Publishing")).toHaveFocus());
  expect(choice("Publishing")).toBeEnabled();
});

it("holds the form while a save is in flight", async () => {
  const user = userEvent.setup();
  const store = memory();
  let finish = () => {};
  const held: AgentStore = {
    ...store,
    set: vi.fn(async (key, value) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await store.set(key, value);
    }),
  };
  render(<BaseInstructions store={held} />);
  await choose(user, "Etiquette", "Custom");
  await choose(user, "Progress", "Off");
  await user.click(screen.getByRole("button", { name: "Save" }));
  try {
    await waitFor(() => expect(held.set).toHaveBeenCalledOnce());
    // Held, and able to take the focus when Save leaves: a disabled control
    // is not, though jsdom lets one.
    expect(choice("Progress")).toHaveAttribute("aria-readonly", "true");
    expect(choice("Progress")).toBeEnabled();
    expect(editor("Etiquette")).toBeDisabled();
    expect(
      screen.getByRole("textbox", { name: "Default text for Publishing" }),
    ).toBeEnabled();
    await user.click(choice("Progress"));
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(ownerChoices(store)).toEqual({});
  } finally {
    finish();
  }
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument(),
  );
  expect(ownerChoices(store)).toEqual({ progress: { mode: "off" } });
  expect(choice("Progress")).toBeEnabled();
});

it("reopens on the saved choices while a save is in flight, and shows it failed", async () => {
  const user = userEvent.setup();
  let fail = (_: Error) => {};
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  // The device's file write is held, then fails: the store shows the value
  // as soon as it is written, and puts the saved one back.
  const store = fileStore(new Map(), async () => {
    entered();
    await new Promise<void>((_, reject) => {
      fail = reject;
    });
  });
  const first = render(<BaseInstructions store={store} />);
  await choose(user, "Progress", "Off");
  await user.click(screen.getByRole("button", { name: "Save" }));
  try {
    await started;
    first.unmount();
    render(<BaseInstructions store={store} />);
    expect(choice("Progress")).toHaveTextContent("Default");
    expect(choice("Progress")).toHaveAttribute("aria-readonly", "true");
  } finally {
    fail(new Error("The disk is full"));
  }
  expect(await screen.findByText("The disk is full")).toBeInTheDocument();
  expect(choice("Progress")).toHaveTextContent("Default");
  expect(choice("Progress")).not.toHaveAttribute("aria-readonly", "true");
  expect(ownerChoices(store)).toEqual({});
});

function ownerSectionsHash(id: string) {
  const section = SECTIONS.find((candidate) => candidate.id === id);
  if (!section) throw new Error(id);
  return defaultHash(section);
}
