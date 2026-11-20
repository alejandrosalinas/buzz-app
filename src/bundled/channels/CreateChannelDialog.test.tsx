// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  createRelaySession,
  type RelaySession,
} from "../../features/relay/session";
import type { Agents } from "../../features/agents/service";
import type { AgentChoicesSnapshot } from "../../features/agents/choices";
import { channelTemplates } from "../../features/channel-templates/local";
import {
  projectTemplateId,
  workspaceCanvas,
} from "../../features/solo/workspace";
import type { KitEntry } from "../../features/channel-templates/model";
import { CreateChannelDialog } from "./CreateChannelDialog";

let store = createRelaySession(null);
const setupProps = () => ({
  session: store.session,
  destinations: [],
  initialGroup: "",
  groupsReady: true,
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  store.dispose();
  store = createRelaySession(null);
});

it.each([false, true])(
  "shares standalone workspace instructions unless unticked (%s)",
  async (share) => {
    vi.stubGlobal("crypto", webcrypto);
    const user = userEvent.setup();
    const id = await projectTemplateId("work");
    const entry: KitEntry = {
      eventId: "head",
      createdAt: 1,
      record: {
        version: 1,
        community: "https://relay.example.org",
        deleted: false,
        value: {
          type: "template",
          id,
          name: "Work defaults",
          description: "",
          teamIds: [],
          agents: [],
          canvas: workspaceCanvas({
            folders: ["/local/project"],
            worktree: { location: "/local/worktrees", baseBranch: "main" },
            canvas: "Release checklist",
          }),
        },
      },
    };
    const session = {
      ...store.session,
      channelKit: {
        ...store.session.channelKit,
        available: true,
        snapshot: () => ({ status: "ready" as const, entries: [entry] }),
        refresh: async () => {},
      },
    };
    const onCreate = vi.fn(async () => {});
    render(
      <CreateChannelDialog
        {...setupProps()}
        session={session}
        initialGroup="work"
        destinations={[{ id: "work", name: "Work" }]}
        open
        onOpenChange={() => {}}
        onCreate={onCreate}
      />,
    );
    const checkbox = await screen.findByRole("checkbox", {
      name: "Copy workspace instructions to the shared Canvas",
    });
    expect(checkbox).toBeChecked();
    if (!share) await user.click(checkbox);
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Notes");
    await user.click(screen.getByRole("button", { name: "Create channel" }));
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      name: "Notes",
      visibility: "open",
      setup: {
        agents: [],
        groupId: "work",
        templateId: id,
        canvas: share ? "Release checklist" : "",
      },
    });
  },
);

it("shows description immediately with Name focused and creates an ongoing open channel", async () => {
  const user = userEvent.setup();
  const onCreate = vi.fn(async () => {});
  const onOpenChange = vi.fn();
  render(
    <CreateChannelDialog
      {...setupProps()}
      open
      onOpenChange={onOpenChange}
      onCreate={onCreate}
    />,
  );
  expect(
    screen.getByRole("dialog", { name: "Create a channel" }),
  ).not.toHaveAccessibleDescription();
  expect(screen.getByRole("textbox", { name: "Description" })).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue("");
  expect(
    screen.queryByRole("button", { name: "Add a description" }),
  ).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus(),
  );
  expect(screen.queryByText("Optional")).not.toBeInTheDocument();
  expect(screen.getByText("Duration")).toHaveClass("sr-only");
  expect(screen.getByRole("radiogroup", { name: "Duration" })).toBeVisible();
  expect(screen.getByRole("radio", { name: /Ongoing/ })).toBeChecked();
  const privateSwitch = screen.getByRole("switch", { name: "Private" });
  const privateLabel = screen.getByText("Private", { selector: "label" });
  expect(privateSwitch).not.toBeChecked();
  expect(
    privateSwitch.compareDocumentPosition(privateLabel) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Cancel" }),
  ).not.toBeInTheDocument();
  await user.type(screen.getByRole("textbox", { name: "Name" }), "  launch  ");
  await user.tab();
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveFocus();
  await user.type(
    screen.getByRole("textbox", { name: "Description" }),
    "  Release planning  ",
  );
  await user.click(screen.getByRole("button", { name: "Create channel" }));
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith({
      name: "launch",
      description: "Release planning",
      visibility: "open",
    }),
  );
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("creates a private temporary channel and reports a rejected request", async () => {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  const onCreate = vi.fn(async () => {
    throw new Error("Creation rejected");
  });
  render(
    <CreateChannelDialog
      {...setupProps()}
      open
      onOpenChange={onOpenChange}
      onCreate={onCreate}
    />,
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "ops");
  await user.click(screen.getByRole("radio", { name: /Temporary/ }));
  await user.click(screen.getByText("Private", { selector: "label" }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Create channel" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Creation rejected",
  );
  expect(onCreate).toHaveBeenCalledWith({
    name: "ops",
    visibility: "private",
    ttlSeconds: 604800,
  });
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(screen.getByRole("radio", { name: /Temporary/ })).toBeChecked();
  expect(screen.getByRole("switch", { name: "Private" })).toBeChecked();
});

it("keeps an editable draft after a failed creation, retries it, and forgets it on close", async () => {
  const user = userEvent.setup();
  const onCreate = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("Creation rejected"))
    .mockResolvedValueOnce(undefined);
  const onOpenChange = vi.fn();
  const forget = vi.fn();
  const view = render(
    <CreateChannelDialog
      {...setupProps()}
      session={{
        ...store.session,
        channelCreation: { ...store.session.channelCreation, forget },
      }}
      open
      onOpenChange={onOpenChange}
      onCreate={onCreate}
    />,
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "ops");
  await user.type(
    screen.getByRole("textbox", { name: "Description" }),
    "Incident response",
  );
  await user.click(screen.getByRole("radio", { name: /Temporary/ }));
  await user.click(screen.getByText("Private", { selector: "label" }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Create channel" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Creation rejected",
  );
  expect(screen.getByRole("textbox", { name: "Name" })).toBeEnabled();
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("ops");
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
    "Incident response",
  );
  expect(screen.getByRole("radio", { name: /Temporary/ })).toBeChecked();
  expect(screen.getByRole("switch", { name: "Private" })).toBeChecked();
  expect(onOpenChange).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Create channel" }));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  const request = {
    name: "ops",
    description: "Incident response",
    visibility: "private",
    ttlSeconds: 604800,
  };
  expect(onCreate.mock.calls).toEqual([[request], [request]]);
  expect(forget).not.toHaveBeenCalled();
  view.unmount();
  expect(forget).toHaveBeenCalledOnce();
});

it("blocks edits during creation without applying disabled control styles", async () => {
  const user = userEvent.setup();
  let finishCreation!: () => void;
  const onCreate = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishCreation = resolve;
      }),
  );
  const onOpenChange = vi.fn();
  render(
    <CreateChannelDialog
      {...setupProps()}
      open
      onOpenChange={onOpenChange}
      onCreate={onCreate}
    />,
  );
  const name = screen.getByRole("textbox", { name: "Name" });
  const privateSwitch = screen.getByRole("switch", { name: "Private" });
  await user.type(name, "launch");
  await user.click(screen.getByRole("button", { name: "Create channel" }));
  const form = document.getElementById("create-channel-form");
  await waitFor(() => expect(form).toHaveAttribute("inert"));
  expect(form).toHaveAttribute("aria-busy", "true");
  expect(name).not.toBeDisabled();
  expect(privateSwitch).not.toBeDisabled();
  expect(privateSwitch).toHaveAttribute("aria-disabled", "true");
  await user.click(privateSwitch);
  expect(privateSwitch).not.toBeChecked();
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Create a channel");
  try {
    await user.keyboard("{Escape}");
    await user.click(
      document.querySelector(".buzz-dialog-backdrop") as Element,
    );
    expect(
      screen.getByRole("button", { name: "Close channel creation" }),
    ).toBeDisabled();
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Create a channel");
    expect(onOpenChange).not.toHaveBeenCalled();
  } finally {
    finishCreation();
  }
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
});

it.each([
  ["\u0085# \u0085#Release\u0085", "Release"],
  ["\ufeffRelease\ufeff", "\ufeffRelease\ufeff"],
])(
  "passes the relay-canonical name for %j to creation",
  async (value, expected) => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {});
    render(
      <CreateChannelDialog
        {...setupProps()}
        open
        onOpenChange={() => {}}
        onCreate={onCreate}
      />,
    );
    const name = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "### " } });
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription(/Enter a channel name/);
    expect(
      screen.getByRole("button", { name: "Create channel" }),
    ).toBeDisabled();
    fireEvent.change(name, { target: { value } });
    await user.click(screen.getByRole("button", { name: "Create channel" }));
    expect(onCreate).toHaveBeenCalledWith({
      name: expected,
      visibility: "open",
    });
  },
);
it("caps the description at 1,000 characters", async () => {
  const user = userEvent.setup();
  render(
    <CreateChannelDialog
      {...setupProps()}
      open
      onOpenChange={() => {}}
      onCreate={async () => {}}
    />,
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "notes");
  const description = screen.getByRole("textbox", { name: "Description" });
  fireEvent.change(description, { target: { value: "x".repeat(1001) } });
  expect(description).toHaveValue("x".repeat(1000));
  expect(description).toHaveAccessibleDescription("1,000 of 1,000 characters");
  expect(screen.getByRole("button", { name: "Create channel" })).toBeEnabled();
});

it("steps the temporary duration, preserves it across Ongoing, and submits only on Create", async () => {
  const user = userEvent.setup();
  const onCreate = vi.fn(async () => {});
  render(
    <CreateChannelDialog
      {...setupProps()}
      open
      onOpenChange={() => {}}
      onCreate={onCreate}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Increase duration" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("radio", { name: "Temporary" }),
  ).toHaveAccessibleDescription("Archives without activity.");
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Short lived");
  await user.click(screen.getByRole("radio", { name: "Temporary" }));
  await waitFor(() =>
    expect(
      screen.getByText("after 7 days", { selector: "strong" }),
    ).toBeVisible(),
  );
  const shorter = screen.getByRole("button", { name: "Decrease duration" });
  const longer = screen.getByRole("button", { name: "Increase duration" });
  await user.click(shorter);
  await waitFor(() =>
    expect(
      screen.getByText("after 1 day", { selector: "strong" }),
    ).toBeVisible(),
  );
  expect(shorter).toBeDisabled();
  await user.click(longer);
  await waitFor(() =>
    expect(
      screen.getByText("after 7 days", { selector: "strong" }),
    ).toBeVisible(),
  );
  await user.click(longer);
  await waitFor(() =>
    expect(
      screen.getByText("after 2 weeks", { selector: "strong" }),
    ).toBeVisible(),
  );
  expect(longer).toBeDisabled();
  await user.click(shorter);
  await waitFor(() =>
    expect(
      screen.getByText("after 7 days", { selector: "strong" }),
    ).toBeVisible(),
  );
  await user.click(shorter);
  await user.click(screen.getByRole("radio", { name: "Ongoing" }));
  expect(
    screen.queryByRole("button", { name: "Increase duration" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("radio", { name: "Temporary" }));
  await waitFor(() =>
    expect(
      screen.getByText("after 1 day", { selector: "strong" }),
    ).toBeVisible(),
  );
  expect(onCreate).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Create channel" }));
  expect(onCreate).toHaveBeenCalledExactlyOnceWith({
    name: "Short lived",
    visibility: "open",
    ttlSeconds: 86400,
  });
});

it("confirms both privacy directions in the same modal and preserves the entire creation draft", async () => {
  const user = userEvent.setup();
  const onCreate = vi.fn(async () => {});
  const onOpenChange = vi.fn();
  render(
    <CreateChannelDialog
      {...setupProps()}
      open
      onOpenChange={onOpenChange}
      onCreate={onCreate}
    />,
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Draft");
  await user.type(
    screen.getByRole("textbox", { name: "Description" }),
    "Keep this",
  );
  await user.click(screen.getByRole("radio", { name: "Temporary" }));
  await user.click(screen.getByRole("button", { name: "Increase duration" }));
  const dialog = screen.getByRole("dialog");
  for (const initialPrivate of [false, true]) {
    for (const dismissal of ["Cancel", "Escape", "Close"]) {
      await user.click(screen.getByText("Private", { selector: "label" }));
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(dialog).toHaveAccessibleName(
        initialPrivate ? "Make channel public?" : "Make channel private?",
      );
      const consequence = initialPrivate
        ? "Everyone in this community will be able to view this channel’s full history."
        : "Only channel members will have access.";
      expect(dialog).toHaveAccessibleDescription(consequence);
      await waitFor(() => expect(screen.getByText(consequence)).toBeVisible());
      expect(
        screen.getByText(consequence).closest(".buzz-dialog-body"),
      ).toHaveAttribute("data-footer-gap", "compact");
      expect(
        screen.queryByText(/This choice takes effect/),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
      const remember = screen.getByRole("checkbox", {
        name: "Don’t show me this again",
      });
      expect(remember).not.toBeChecked();
      await user.click(remember);
      expect(
        screen.queryByRole("textbox", { name: "Name" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Create channel" }),
      ).not.toBeInTheDocument();
      if (dismissal === "Escape") await user.keyboard("{Escape}");
      else
        await user.click(
          screen.getByRole("button", {
            name: dismissal === "Close" ? "Back to channel creation" : "Cancel",
          }),
        );
      expect(dialog).toHaveAccessibleName("Create a channel");
      expect(screen.getByRole("switch", { name: "Private" })).toHaveFocus();
      expect(screen.getByRole("switch", { name: "Private" })).toHaveAttribute(
        "aria-checked",
        String(initialPrivate),
      );
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
        "Draft",
      );
      expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
        "Keep this",
      );
      expect(
        screen.getByRole("radio", { name: "Temporary" }),
      ).toHaveAccessibleDescription("Archives after 2 weeks without activity.");
      expect(onOpenChange).not.toHaveBeenCalled();
    }
    await user.click(screen.getByRole("switch", { name: "Private" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("switch", { name: "Private" })).toHaveFocus();
    expect(screen.getByRole("switch", { name: "Private" })).toHaveAttribute(
      "aria-checked",
      String(!initialPrivate),
    );
    expect(onCreate).not.toHaveBeenCalled();
  }
  await user.click(screen.getByRole("button", { name: "Create channel" }));
  expect(onCreate).toHaveBeenCalledExactlyOnceWith({
    name: "Draft",
    description: "Keep this",
    visibility: "open",
    ttlSeconds: 1209600,
  });
});

it("discards the unsaved privacy step and draft when creation closes and reopens", async () => {
  const user = userEvent.setup();
  const props = {
    ...setupProps(),
    open: true,
    onOpenChange: vi.fn(),
    onCreate: vi.fn(async () => {}),
  };
  const view = render(<CreateChannelDialog {...props} />);
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Draft");
  await user.click(screen.getByRole("switch", { name: "Private" }));
  view.rerender(<CreateChannelDialog {...props} open={false} />);
  view.rerender(<CreateChannelDialog {...props} />);
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Create a channel");
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
  expect(screen.getByRole("switch", { name: "Private" })).not.toBeChecked();
  expect(props.onCreate).not.toHaveBeenCalled();
});

it.each(["work", "", "starred"])(
  "prefills the title and destination from the opening group %j",
  async (initialGroup) => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {});
    render(
      <CreateChannelDialog
        {...setupProps()}
        open
        onOpenChange={() => {}}
        onCreate={onCreate}
        initialGroup={initialGroup === "starred" ? "" : initialGroup}
        initialStarred={initialGroup === "starred"}
        destinations={[{ id: "work", name: "Work", icon: "📚" }]}
      />,
    );
    const title =
      initialGroup === "starred"
        ? "Create a channel in Starred"
        : initialGroup
          ? "Create a channel in Work"
          : "Create a channel";
    expect(screen.getByRole("dialog")).toHaveAccessibleName(title);
    const workspace = screen.queryByRole("combobox", {
      name: "Destination workspace",
    });
    if (initialGroup === "work") expect(workspace).toHaveTextContent("Work");
    else expect(workspace).not.toBeInTheDocument();
    if (initialGroup === "starred")
      expect(
        screen
          .getByRole("dialog")
          .querySelector("[data-sidebar-group-icon] svg"),
      ).toBeInTheDocument();
    else if (initialGroup)
      expect(
        screen
          .getByRole("dialog")
          .querySelector(".buzz-dialog-step [data-sidebar-group-icon]"),
      ).toHaveTextContent("📚");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Notes");
    await user.click(screen.getByRole("switch", { name: "Private" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName(title);
    await user.click(screen.getByRole("button", { name: "Create channel" }));
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      name: "Notes",
      visibility: "private",
      ...(initialGroup
        ? {
            setup: {
              agents: [],
              canvas: "",
              templateId: "",
              groupId: initialGroup === "starred" ? "" : initialGroup,
              ...(initialGroup === "starred" ? { starred: true } : {}),
            },
          }
        : {}),
    });
  },
);

it.each([true, false])(
  "does not silently change a missing or loading opening group (ready: %s)",
  async (groupsReady) => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {});
    const props = {
      ...setupProps(),
      open: true,
      onOpenChange: vi.fn(),
      onCreate,
      initialGroup: "work",
      groupsReady,
    };
    const view = render(<CreateChannelDialog {...props} destinations={[]} />);
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Notes");
    await user.click(screen.getByRole("button", { name: "Create channel" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      groupsReady
        ? "This workspace is no longer available. Choose another workspace or Team."
        : "Wait for saved workspaces to load, then try again.",
    );
    expect(onCreate).not.toHaveBeenCalled();
    view.rerender(
      <CreateChannelDialog
        {...props}
        groupsReady
        destinations={[{ id: "work", name: "Work" }]}
      />,
    );
    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      "Create a channel in Work",
    );
    await user.click(screen.getByRole("button", { name: "Create channel" }));
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        setup: expect.objectContaining({ groupId: "work" }),
      }),
    );
  },
);

it.each(["backdrop", "Escape", "Close"])(
  "guards dirty Create dismissal via %s and only discards explicitly",
  async (dismissal) => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onCreate = vi.fn(async () => {});
    render(
      <CreateChannelDialog
        {...setupProps()}
        open
        onOpenChange={onOpenChange}
        onCreate={onCreate}
      />,
    );
    const dismiss = async () => {
      if (dismissal === "backdrop")
        await user.click(
          document.querySelector(".buzz-dialog-backdrop") as Element,
        );
      else if (dismissal === "Escape") await user.keyboard("{Escape}");
      else
        await user.click(
          screen.getByRole("button", { name: "Close channel creation" }),
        );
    };
    await dismiss();
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    onOpenChange.mockClear();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Draft");
    const dialog = screen.getByRole("dialog");
    for (const back of ["Keep editing", "Escape", "backdrop", "Close"]) {
      await dismiss();
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(screen.getAllByRole("dialog")).toEqual([dialog]);
      expect(dialog).toHaveAccessibleName("Discard changes?");
      expect(
        screen.getByRole("button", { name: "Keep editing" }),
      ).toHaveFocus();
      if (back === "Escape") await user.keyboard("{Escape}");
      else if (back === "backdrop")
        await user.click(
          document.querySelector(".buzz-dialog-backdrop") as Element,
        );
      else
        await user.click(
          screen.getByRole("button", {
            name: back === "Close" ? "Back to channel creation" : back,
          }),
        );
      expect(dialog).toHaveAccessibleName("Create a channel");
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
        "Draft",
      );
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
      expect(onOpenChange).not.toHaveBeenCalled();
    }
    await dismiss();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(onCreate).not.toHaveBeenCalled();
  },
);

it.each(["Name", "Description", "Private", "Temporary"])(
  "protects Create edits to %s and closes a reverted draft without confirmation",
  async (field) => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <CreateChannelDialog
        {...setupProps()}
        open
        onOpenChange={onOpenChange}
        onCreate={async () => {}}
      />,
    );
    if (field === "Name" || field === "Description")
      await user.type(screen.getByRole("textbox", { name: field }), "draft");
    else if (field === "Temporary")
      await user.click(screen.getByRole("radio", { name: field }));
    else {
      await user.click(screen.getByRole("switch", { name: "Private" }));
      await user.click(screen.getByRole("button", { name: "Continue" }));
    }
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Discard changes?");
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    if (field === "Name" || field === "Description")
      await user.clear(screen.getByRole("textbox", { name: field }));
    else if (field === "Temporary")
      await user.click(screen.getByRole("radio", { name: "Ongoing" }));
    else {
      await user.click(screen.getByRole("switch", { name: "Private" }));
      await user.click(screen.getByRole("button", { name: "Continue" }));
    }
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  },
);

const ada = "a".repeat(64);
const bo = "b".repeat(64);
const elsewhere = "c".repeat(64);
/** Teams on this device; whether members are agents here is the selection's call. */
const teamsSnapshot = {
  status: "ready",
  running: [],
  agents: [],
  teams: [
    { id: "t1", name: "Core", instructions: "", members: [ada, elsewhere] },
    { id: "t2", name: "Docs", instructions: "", members: [bo, ada] },
  ],
};
const teamAgents = {
  snapshot: () => teamsSnapshot,
  subscribe: () => () => {},
} as unknown as Agents;
const listingFailed = "Agents could not be listed";
/** The shared selection with the native list in `status` and archive evidence. */
function agentChoices(state: {
  status: "loading" | "ready" | "error";
  agents?: readonly { pubkey: string; name: string }[];
  archives?: "idle" | "loading" | "ready" | "error";
  archived?: readonly string[];
}): AgentChoicesSnapshot {
  const identities = (state.agents ?? []).map((agent) => ({
    ...agent,
    managed: true,
    managedName: agent.name,
  }));
  const archives = {
    status: state.archives ?? "ready",
    archived: state.archived ?? [],
  } as const;
  const error = state.status === "error" ? { error: listingFailed } : {};
  return {
    status: state.status,
    identities,
    selectable: identities.filter((a) => !archives.archived.includes(a.pubkey)),
    archives,
    templates: {
      status: state.status,
      identities,
      complete: state.status === "ready",
      pending: state.status === "loading",
      ...error,
    },
    definitions: [],
    complete: state.status === "ready",
    pending: state.status === "loading",
    ...error,
  };
}
/** The store's session, its selection projection replaced by a scripted one. */
function sessionWithChoices(initial: AgentChoicesSnapshot) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const ensure = vi.fn();
  const refresh = vi.fn(async () => {});
  const session = {
    ...store.session,
    agentChoices: {
      ...store.session.agentChoices,
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      ensure,
      refresh,
    },
  } as RelaySession;
  return {
    session,
    ensure,
    refresh,
    update(next: AgentChoicesSnapshot) {
      snapshot = next;
      act(() => {
        for (const listener of [...listeners]) listener();
      });
    },
  };
}
const launchTemplate = () =>
  channelTemplates.save({
    name: "Launch",
    teams: ["t1", "t2", "gone"],
    agents: [elsewhere, bo],
    canvas: "# Goal",
  });

it("starts a channel from a template with its agents and teams' agents here and its Canvas", async () => {
  const user = userEvent.setup();
  const choices = sessionWithChoices(
    agentChoices({
      status: "ready",
      agents: [
        { pubkey: ada, name: "Ada" },
        { pubkey: bo, name: "Bo" },
      ],
    }),
  );
  const template = launchTemplate();
  const onCreate = vi.fn(async () => {});
  render(
    <CreateChannelDialog
      {...setupProps()}
      session={choices.session}
      agents={teamAgents}
      open
      onOpenChange={() => {}}
      onCreate={onCreate}
    />,
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "launch");
  await user.click(screen.getByRole("combobox", { name: "Template" }));
  await user.click(await screen.findByRole("option", { name: "Launch" }));
  expect(screen.getByText("Adds Bo, Ada · Starts the Canvas")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Create channel" }));
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith({
      name: "launch",
      visibility: "open",
      setup: {
        agents: [bo, ada],
        canvas: "# Goal",
        groupId: "",
        templateId: template.id,
      },
    }),
  );
});

it.each([
  ["the agent list is loading", { status: "loading" as const }],
  [
    "archive evidence is unread",
    { status: "ready" as const, archives: "idle" as const },
  ],
])("holds creation from a template while %s", async (_case, state) => {
  const user = userEvent.setup();
  const here = [
    { pubkey: ada, name: "Ada" },
    { pubkey: bo, name: "Bo" },
  ];
  const choices = sessionWithChoices(agentChoices({ ...state, agents: here }));
  const template = launchTemplate();
  const onCreate = vi.fn(async () => {});
  render(
    <CreateChannelDialog
      {...setupProps()}
      session={choices.session}
      agents={teamAgents}
      open
      onOpenChange={() => {}}
      onCreate={onCreate}
    />,
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "launch");
  expect(choices.ensure).not.toHaveBeenCalledWith(false, true);
  await user.click(screen.getByRole("combobox", { name: "Template" }));
  await user.click(await screen.findByRole("option", { name: "Launch" }));
  expect(
    screen.getByText("Checking which of its agents are in this community…"),
  ).toBeVisible();
  // Archive evidence is demanded only once a template needs it.
  expect(choices.ensure).toHaveBeenCalledWith(false, true);
  const create = screen.getByRole("button", { name: "Create channel" });
  expect(create).toBeDisabled();
  fireEvent.submit(document.getElementById("create-channel-form") as Element);
  choices.update(agentChoices({ status: "ready", agents: here }));
  expect(screen.getByText("Adds Bo, Ada · Starts the Canvas")).toBeVisible();
  expect(create).toBeEnabled();
  await user.click(create);
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      name: "launch",
      visibility: "open",
      setup: {
        agents: [bo, ada],
        canvas: "# Goal",
        groupId: "",
        templateId: template.id,
      },
    }),
  );
});

it("holds creation from a template that names only agents until they are checked", async () => {
  const user = userEvent.setup();
  const here = [{ pubkey: bo, name: "Bo" }];
  const choices = sessionWithChoices(
    agentChoices({ status: "loading", agents: here }),
  );
  channelTemplates.save({ name: "Pair", teams: [], agents: [bo], canvas: "" });
  render(
    <CreateChannelDialog
      {...setupProps()}
      session={choices.session}
      agents={teamAgents}
      open
      onOpenChange={() => {}}
      onCreate={async () => {}}
    />,
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "pair");
  await user.click(screen.getByRole("combobox", { name: "Template" }));
  await user.click(await screen.findByRole("option", { name: "Pair" }));
  expect(
    screen.getByText("Checking which of its agents are in this community…"),
  ).toBeVisible();
  const create = screen.getByRole("button", { name: "Create channel" });
  expect(create).toBeDisabled();
  choices.update(agentChoices({ status: "ready", agents: here }));
  expect(screen.getByText("Adds Bo")).toBeVisible();
  expect(create).toBeEnabled();
});

it("reports a failed agent list and creates without the template only on request", async () => {
  const user = userEvent.setup();
  const choices = sessionWithChoices(agentChoices({ status: "error" }));
  launchTemplate();
  const onCreate = vi.fn(async () => {});
  render(
    <CreateChannelDialog
      {...setupProps()}
      session={choices.session}
      agents={teamAgents}
      open
      onOpenChange={() => {}}
      onCreate={onCreate}
    />,
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "launch");
  await user.click(screen.getByRole("combobox", { name: "Template" }));
  await user.click(await screen.findByRole("option", { name: "Launch" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Its agents can’t be checked right now, so they can’t be added. Retry, or choose None to create the channel without them.",
  );
  expect(
    screen.queryByText(/None of its agents are in this community/),
  ).not.toBeInTheDocument();
  const create = screen.getByRole("button", { name: "Create channel" });
  expect(create).toBeDisabled();
  fireEvent.submit(document.getElementById("create-channel-form") as Element);
  await user.click(screen.getByRole("combobox", { name: "Template" }));
  await user.click(await screen.findByRole("option", { name: "None" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(create).toBeEnabled();
  await user.click(create);
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      name: "launch",
      visibility: "open",
    }),
  );
});

it("retries a failed archive read without dropping the template", async () => {
  const user = userEvent.setup();
  const here = [
    { pubkey: ada, name: "Ada" },
    { pubkey: bo, name: "Bo" },
  ];
  const choices = sessionWithChoices(
    agentChoices({ status: "ready", agents: here, archives: "error" }),
  );
  // Each refresh reads anew: the read is held open until released.
  let release = () => {};
  choices.refresh.mockImplementation(() => {
    choices.update(
      agentChoices({ status: "ready", agents: here, archives: "loading" }),
    );
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const template = launchTemplate();
  const onCreate = vi.fn(async () => {});
  render(
    <CreateChannelDialog
      {...setupProps()}
      session={choices.session}
      agents={teamAgents}
      open
      onOpenChange={() => {}}
      onCreate={onCreate}
    />,
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "launch");
  await user.click(screen.getByRole("combobox", { name: "Template" }));
  await user.click(await screen.findByRole("option", { name: "Launch" }));
  const create = screen.getByRole("button", { name: "Create channel" });
  expect(create).toBeDisabled();
  const retry = screen.getByRole("button", { name: "Retry" });
  expect(screen.getByRole("alert")).toContainElement(retry);

  // A retry that fails again keeps the error, the draft and the control.
  await user.click(retry);
  expect(choices.refresh).toHaveBeenCalledExactlyOnceWith("templates");
  expect(retry).toHaveAttribute("aria-busy", "true");
  expect(retry).toHaveFocus();
  expect(
    screen.queryByText("Checking which of its agents are in this community…"),
  ).not.toBeInTheDocument();
  choices.update(
    agentChoices({ status: "ready", agents: here, archives: "error" }),
  );
  release();
  await waitFor(() => expect(retry).not.toHaveAttribute("aria-busy"));
  expect(retry).toHaveFocus();
  expect(screen.getByRole("alert")).toHaveTextContent(/can’t be checked/);
  expect(create).toBeDisabled();

  // A retry that reads the evidence resolves the field and hands focus back.
  await user.click(retry);
  expect(choices.refresh).toHaveBeenCalledTimes(2);
  choices.update(agentChoices({ status: "ready", agents: here }));
  expect(retry).toHaveFocus();
  release();
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByRole("combobox", { name: "Template" })).toHaveFocus();
  expect(screen.getByRole("combobox", { name: "Template" })).toHaveTextContent(
    "Launch",
  );
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("launch");
  expect(screen.getByText("Adds Bo, Ada · Starts the Canvas")).toBeVisible();
  expect(create).toBeEnabled();
  await user.click(create);
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      name: "launch",
      visibility: "open",
      setup: {
        agents: [bo, ada],
        canvas: "# Goal",
        groupId: "",
        templateId: template.id,
      },
    }),
  );
});

it("leaves an archived team member out of the template's agents", async () => {
  const user = userEvent.setup();
  const choices = sessionWithChoices(
    agentChoices({
      status: "ready",
      agents: [
        { pubkey: ada, name: "Ada" },
        { pubkey: bo, name: "Bo" },
      ],
      archived: [bo],
    }),
  );
  const template = launchTemplate();
  const onCreate = vi.fn(async () => {});
  render(
    <CreateChannelDialog
      {...setupProps()}
      session={choices.session}
      agents={teamAgents}
      open
      onOpenChange={() => {}}
      onCreate={onCreate}
    />,
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "launch");
  await user.click(screen.getByRole("combobox", { name: "Template" }));
  await user.click(await screen.findByRole("option", { name: "Launch" }));
  expect(screen.getByText("Adds Ada · Starts the Canvas")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Create channel" }));
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        setup: {
          agents: [ada],
          canvas: "# Goal",
          groupId: "",
          templateId: template.id,
        },
      }),
    ),
  );
});

it("creates a plain channel from a template whose members are all elsewhere once agents are ready", async () => {
  const user = userEvent.setup();
  const choices = sessionWithChoices(agentChoices({ status: "ready" }));
  channelTemplates.save({
    name: "Core only",
    teams: ["t1"],
    agents: [],
    canvas: "",
  });
  const onCreate = vi.fn(async () => {});
  render(
    <CreateChannelDialog
      {...setupProps()}
      session={choices.session}
      agents={teamAgents}
      open
      onOpenChange={() => {}}
      onCreate={onCreate}
    />,
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "plain");
  await user.click(screen.getByRole("combobox", { name: "Template" }));
  await user.click(await screen.findByRole("option", { name: "Core only" }));
  expect(
    screen.getByText(
      "None of its agents are in this community, and it has no Canvas.",
    ),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Create channel" }));
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith({
      name: "plain",
      visibility: "open",
      // Kept so a retry still matches once the template resolves differently.
      setup: {
        agents: [],
        canvas: "",
        groupId: "",
        templateId: expect.any(String),
      },
    }),
  );
});

it("offers no template choice without saved templates", () => {
  render(
    <CreateChannelDialog
      {...setupProps()}
      open
      onOpenChange={() => {}}
      onCreate={async () => {}}
    />,
  );
  expect(
    screen.queryByRole("combobox", { name: "Template" }),
  ).not.toBeInTheDocument();
});

it("creates a plain channel from a template that adds nothing here", async () => {
  const user = userEvent.setup();
  channelTemplates.save({
    name: "Empty",
    teams: ["gone"],
    agents: [],
    canvas: "  ",
  });
  const onCreate = vi.fn(async () => {});
  render(
    <CreateChannelDialog
      {...setupProps()}
      open
      onOpenChange={() => {}}
      onCreate={onCreate}
    />,
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "plain");
  await user.click(screen.getByRole("combobox", { name: "Template" }));
  await user.click(await screen.findByRole("option", { name: "Empty" }));
  expect(
    screen.getByText(
      "None of its agents are in this community, and it has no Canvas.",
    ),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Create channel" }));
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith({
      name: "plain",
      visibility: "open",
      // Kept so a retry still matches once the template resolves differently.
      setup: {
        agents: [],
        canvas: "",
        groupId: "",
        templateId: expect.any(String),
      },
    }),
  );
});
