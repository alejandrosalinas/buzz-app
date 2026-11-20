// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import {
  parseKitRecord,
  type KitEntry,
  type Template,
} from "../channel-templates/model";
import { NewWorkspace } from "./NewWorkspace";
import { createRelaySession } from "../relay/session";
import { channelTemplates } from "../channel-templates/local";
import { readyAgentChoices } from "../agents/test-fakes";
// Template agent checks read these; `readyChoices` makes one agent available.
const templateSession = (({ agentChoices, channels }) => ({
  agentChoices,
  channels,
}))(createRelaySession(null).session);
const agent = "b".repeat(64);
const readyChoices = () => {
  const snapshot = readyAgentChoices([{ pubkey: agent, name: "Bo" }]);
  return {
    ...templateSession.agentChoices,
    snapshot: () => snapshot,
    subscribe: () => () => {},
    ensure: () => {},
  };
};

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const prompt = () =>
  screen.findByRole("alertdialog", { name: "Discard changes?" });

it("keeps a workspace draft editable while preferences recover and restores focus", async () => {
  const user = userEvent.setup();
  let writable = false;
  const listeners = new Set<() => void>();
  const recover = () => {
    writable = true;
    for (const listener of listeners) listener();
  };
  const create = vi.fn(async () => {});
  const session = {
    ...templateSession,
    scope: "https://relay.example.test:viewer",
    sidebarPreferences: {
      get sectionCreationWritable() {
        return writable;
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      refresh: vi.fn(async () => recover()),
    },
  } as unknown as RelaySession;
  render(
    <NewWorkspace
      session={session}
      create={create}
      close={vi.fn()}
      onCreated={vi.fn()}
    />,
  );
  const name = screen.getByRole("textbox", { name: "Name" });
  const submit = screen.getByRole("button", { name: "Create" });
  await user.type(name, "Release");
  expect(submit).toBeDisabled();
  expect(create).not.toHaveBeenCalled();
  const retry = screen.getByRole("button", { name: "Retry preferences" });
  retry.focus();
  act(recover);
  expect(name).toHaveFocus();
  await user.type(name, " notes");
  await user.click(submit);
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ name: "Release notes" }),
  );
});

/** A dialog nothing submits, so only dismissal can close it. */
function mount() {
  const close = vi.fn();
  render(
    <NewWorkspace
      create={vi.fn(async () => {})}
      close={close}
      onCreated={vi.fn()}
      session={
        {
          ...templateSession,
          scope: "https://relay.example.test:viewer",
        } as unknown as RelaySession
      }
    />,
  );
  return {
    close,
    dialog: screen.getByRole("dialog", { name: "New workspace" }),
  };
}

it.each(["add a folder", "turn worktree off"])(
  "blocks publication without a required folder and recovers when you %s",
  async (recovery) => {
    const create = vi.fn(async () => {});
    const save = vi.fn(async () => {});
    const close = vi.fn();
    render(
      <NewWorkspace
        create={create}
        close={close}
        onCreated={vi.fn()}
        session={
          {
            ...templateSession,
            scope: "https://relay.example.test:viewer",
            channelKit: {
              refresh: async () => {},
              snapshot: () => ({ status: "ready", entries: [] }),
              save,
            },
          } as unknown as RelaySession
        }
      />,
    );
    const name = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Work" } });
    const toggle = screen.getByRole("switch", {
      name: "Work in a new worktree",
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Add at least one folder to use a new worktree.",
    );
    // Exercise the submit guard independently of native form validation.
    fireEvent.submit(name.closest("form") as HTMLFormElement);
    expect(
      await screen.findByText(
        "Choose a workspace folder, worktree location, and base branch.",
      ),
    ).toBeVisible();
    expect(create).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    if (recovery === "add a folder") {
      fireEvent.change(screen.getByRole("textbox", { name: /^Folders/ }), {
        target: { value: "~/repo" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    } else fireEvent.click(toggle);
    expect(
      screen.queryByText("Add at least one folder to use a new worktree."),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledTimes(recovery === "add a folder" ? 1 : 0);
  },
);

// This is the dialog's orchestration boundary: a project write and a separate
// defaults write can each fail. Protocol validation belongs to the real kit tests.
it.each(["Close", "Retry"])(
  "keeps a partially saved project frozen until %s",
  async (action) => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entries: KitEntry[] = [];
    const create = vi.fn(async () => {});
    const save = vi.fn(async (template: Template) => {
      await gate;
      entries = [
        {
          record: parseKitRecord(
            { version: 1, community: "", deleted: false, value: template },
            "",
          ),
          eventId: "saved",
          createdAt: 1,
        },
      ];
      throw new Error("Save not confirmed");
    });
    const close = vi.fn();
    render(
      <NewWorkspace
        create={create}
        close={close}
        onCreated={vi.fn()}
        session={
          {
            ...templateSession,
            scope: "https://relay.example.test:viewer",
            channelKit: {
              refresh: async () => {},
              snapshot: () => ({ status: "ready", entries }),
              save,
            },
          } as unknown as RelaySession
        }
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Work" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /^Instructions/ }), {
      target: { value: "Keep changes small" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    try {
      await waitFor(() => expect(save).toHaveBeenCalledOnce());
      for (const closeButton of screen.getAllByRole("button", {
        name: "Close",
      }))
        expect(closeButton).toBeDisabled();
      expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
      expect(
        screen.getByRole("textbox", { name: /^Instructions/ }),
      ).toBeDisabled();
      expect(screen.getByRole("switch")).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(screen.getByRole("textbox", { name: /^Folders/ })).toBeDisabled();
    } finally {
      release();
    }
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Save not confirmed",
    );
    expect(screen.getByRole("textbox", { name: /^Instructions/ })).toHaveValue(
      "Keep changes small",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Name, folders and instructions are kept for the retry.",
    );
    // A stray outside click keeps the retry state and its workspace identity.
    const backdrop = document.querySelector(".buzz-dialog-backdrop") as Element;
    fireEvent.pointerDown(backdrop);
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: /^Instructions/ })).toHaveValue(
      "Keep changes small",
    );
    // Escape asks before the frozen retry state is dropped; Keep editing holds it.
    await user.keyboard("{Escape}");
    const asked = await prompt();
    expect(asked).toHaveAccessibleDescription(
      "Your new workspace has unsaved changes.",
    );
    await user.click(
      within(asked).getByRole("button", { name: "Keep editing" }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Name, folders and instructions are kept for the retry.",
    );
    // Either footer action closes after its own lifecycle. Retry reuses the ID.
    if (action === "Close")
      fireEvent.click(screen.getByText("Close", { selector: "button span" }));
    else fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(save).toHaveBeenCalledOnce();
    if (action === "Retry")
      expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
  },
);

it("rejects oversized defaults with their real community envelope before creating anything", async () => {
  const create = vi.fn(async () => {});
  render(
    <NewWorkspace
      create={create}
      close={vi.fn()}
      onCreated={vi.fn()}
      session={
        {
          ...templateSession,
          scope: "https://relay.example.test:viewer",
        } as unknown as RelaySession
      }
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Work" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: /^Instructions/ }), {
    target: { value: "a".repeat(16_095) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("16 KiB");
  expect(create).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Name" })).toBeEnabled();
});

it.each(["Escape", "Close"])(
  "offers only Close when defaults changed elsewhere and allows %s",
  async (action) => {
    let entries: KitEntry[] = [];
    const save = vi.fn(async (template: Template) => {
      entries = [
        {
          record: parseKitRecord(
            {
              version: 1,
              community: "https://relay.example.test",
              deleted: false,
              value: { ...template, canvas: "Changed elsewhere" },
            },
            "https://relay.example.test",
          ),
          eventId: "changed",
          createdAt: 1,
        },
      ];
      throw new Error("Save not confirmed");
    });
    const close = vi.fn();
    render(
      <NewWorkspace
        create={vi.fn(async () => {})}
        close={close}
        onCreated={vi.fn()}
        session={
          {
            ...templateSession,
            scope: "https://relay.example.test:viewer",
            channelKit: {
              refresh: async () => {},
              snapshot: () => ({ status: "ready", entries }),
              save,
            },
          } as unknown as RelaySession
        }
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Work" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /^Instructions/ }), {
      target: { value: "Keep changes small" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Save not confirmed",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Workspace defaults changed",
      ),
    );
    expect(
      screen.queryByRole("button", { name: /^(Create|Retry)$/ }),
    ).not.toBeInTheDocument();
    expect(save).toHaveBeenCalledOnce();
    // Nothing is left to keep, so Escape closes without asking.
    if (action === "Escape") await userEvent.setup().keyboard("{Escape}");
    else
      fireEvent.click(screen.getByText("Close", { selector: "button span" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  },
);

it.each(["Escape", "Close"] as const)(
  "asks before %s drops typed fields, and Keep editing keeps every value",
  async (dismiss) => {
    const user = userEvent.setup();
    const { close, dialog } = mount();
    const name = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Work" } });
    fireEvent.change(screen.getByRole("textbox", { name: /^Folders/ }), {
      target: { value: "~/repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const toggle = screen.getByRole("switch", {
      name: "Work in a new worktree",
    });
    fireEvent.click(toggle);
    const instructions = screen.getByRole("textbox", {
      name: /^Instructions/,
    });
    fireEvent.change(instructions, { target: { value: "Keep changes small" } });
    const header = within(dialog).getByRole("button", { name: "Close" });
    const act = () =>
      dismiss === "Escape" ? user.keyboard("{Escape}") : user.click(header);
    await act();
    const asked = await prompt();
    expect(asked).toHaveAccessibleDescription(
      "Your new workspace has unsaved changes.",
    );
    const keep = within(asked).getByRole("button", { name: "Keep editing" });
    await waitFor(() => expect(keep).toHaveFocus());
    await user.click(keep);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("dialog", { name: "New workspace" })).toBe(dialog);
    if (dismiss === "Close") await waitFor(() => expect(header).toHaveFocus());
    expect(name).toHaveValue("Work");
    expect(screen.getByRole("button", { name: /^Remove / })).toBeVisible();
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(instructions).toHaveValue("Keep changes small");
    expect(close).not.toHaveBeenCalled();
    // Asked again the same way, Discard changes closes for real.
    await act();
    await user.click(
      within(await prompt()).getByRole("button", { name: "Discard changes" }),
    );
    expect(close).toHaveBeenCalledOnce();
  },
);

it.each(["name", "folder", "worktree", "instructions"] as const)(
  "treats %s alone as unsaved, so Escape asks and Discard changes closes",
  async (field) => {
    const user = userEvent.setup();
    const { close } = mount();
    if (field === "name")
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
        target: { value: "Work" },
      });
    else if (field === "folder") {
      fireEvent.change(screen.getByRole("textbox", { name: /^Folders/ }), {
        target: { value: "~/repo" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    } else if (field === "worktree")
      fireEvent.click(
        screen.getByRole("switch", { name: "Work in a new worktree" }),
      );
    else
      fireEvent.change(screen.getByRole("textbox", { name: /^Instructions/ }), {
        target: { value: "Keep changes small" },
      });
    await user.keyboard("{Escape}");
    await user.click(
      within(await prompt()).getByRole("button", { name: "Discard changes" }),
    );
    expect(close).toHaveBeenCalledOnce();
  },
);

it.each(["Escape", "Close", "Cancel"])(
  "closes without a confirmation when using %s",
  async (action) => {
    const user = userEvent.setup();
    const { close, dialog } = mount();
    if (action === "Cancel")
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
        target: { value: "Work" },
      });
    if (action === "Escape") await user.keyboard("{Escape}");
    else await user.click(within(dialog).getByRole("button", { name: action }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  },
);

it("publishes a template's available agents, and a retry keeps them after the template changes", async () => {
  localStorage.clear();
  const template = channelTemplates.save({
    name: "Review kit",
    teams: [],
    agents: [agent, "c".repeat(64)],
    canvas: "Review carefully",
  });
  let entries: KitEntry[] = [];
  const save = vi.fn(async (value: Template) => {
    entries = [
      {
        record: parseKitRecord(
          { version: 1, community: "", deleted: false, value },
          "",
        ),
        eventId: "saved",
        createdAt: 1,
      },
    ];
    throw new Error("Save not confirmed");
  });
  const close = vi.fn();
  render(
    <NewWorkspace
      create={vi.fn(async () => {})}
      close={close}
      onCreated={vi.fn()}
      session={
        {
          ...templateSession,
          agentChoices: readyChoices(),
          scope: "https://relay.example.test:viewer",
          channelKit: {
            refresh: async () => {},
            snapshot: () => ({ status: "ready", entries }),
            save,
          },
        } as unknown as RelaySession
      }
    />,
  );
  const user = userEvent.setup();
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Work" },
  });
  await user.click(
    screen.getByRole("combobox", { name: "Start from a template" }),
  );
  await user.click(await screen.findByRole("option", { name: "Review kit" }));
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Save not confirmed",
  );
  // Only the owner's agent here is published, with the template's Canvas.
  expect(save).toHaveBeenCalledOnce();
  expect(save.mock.calls[0]?.[0]).toMatchObject({
    agents: [agent],
    canvas: "Review carefully",
  });
  // The retry checks the published snapshot, not the edited template.
  act(() => {
    channelTemplates.save({ ...template, agents: [], canvas: "Changed" });
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledOnce();
});
