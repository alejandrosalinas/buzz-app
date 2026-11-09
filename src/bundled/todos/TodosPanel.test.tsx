import { CanvasConflictError } from "../../features/channel-templates/canvas-conflict";
import { LIVE_CANVAS_LIMIT } from "../../features/channel-templates/model";
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
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { keypair, signed } from "../../features/relay/testing";
import { publicKeyLabels } from "../../shared/identity/public-key";
import { readView, writeView } from "../../shared/view-state";
import type {
  ChannelList,
  ChannelSummary,
} from "../../features/relay/contracts";
import { createRelaySession } from "../../features/relay/session";
import { bindNames } from "../../features/identity-names/service";
import { agentDirectory } from "../../features/identity-names/testing";
import { assignTodo, readTodos } from "./model";
import * as model from "./model";
import { TodosPanel } from "./TodosPanel";
const context = {
  scope: "todos-test",
  channelId: "11111111-1111-4111-8111-111111111111",
  channelName: "Team",
  viewer: "viewer",
  relayUrl: "",
};
const original =
  "# Instructions\nLeave this alone.\n\n## Todos\n\n- [ ] First\n- [x] Done\n\n## Decisions\nKeep this too.\n";
const head = signed(keypair(), {
  kind: 40100,
  created_at: 1700000000,
  content: original,
  tags: [["h", context.channelId]],
});
const session = createRelaySession(null).session;
const list = {
  status: "ready" as const,
  channels: [{ id: context.channelId, name: "Team", members: [] as string[] }],
};
const people = {
  ...session,
  channels: { ...session.channels, list: () => list },
};
function fixture() {
  let current = head;
  const canvas = {
    available: true,
    history: session.canvas.history,
    read: vi.fn(async () => current),
    save: vi.fn(
      async (_channel: string, content: string, base: string | undefined) => {
        if (base !== current.id) throw new CanvasConflictError();
        current = { ...head, content, id: "b".repeat(64) };
        return current;
      },
    ),
  };
  let active = true;
  const props = {
    canvas,
    people,
    context,
    close: vi.fn(),
    onOpenLink: vi.fn(() => true),
    active: () => active,
  };
  return {
    canvas,
    props,
    retire: () => {
      active = false;
    },
    external: () => {
      current = {
        ...head,
        id: "c".repeat(64),
        content: `${original}\nRemote edit.`,
      };
    },
  };
}
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const retry = () => screen.getByRole("button", { name: /^Retry$/ });
const localDraft =
  "Showing your unsaved local draft. Refresh to see the saved list.";
const saved = () =>
  waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Saved in Canvas"),
  );
it("nests tasks across statuses without repeating parent titles and saves only the child checkbox", async () => {
  const f = fixture();
  const content =
    "## Todos\n\n- [/] Ship\n    - [ ] Build\n        - [x] Test\n    - [ ] Publish\n\n## Keep\nUntouched.\n";
  f.canvas.read.mockResolvedValue({ ...head, content });
  render(<TodosPanel {...f.props} />);
  const child = await screen.findByRole("checkbox", { name: "Build" });
  const grandchild = screen.getByRole("checkbox", { name: "Test" });
  const childRow = child.closest("li"),
    grandchildRow = grandchild.closest("li");
  if (!childRow || !grandchildRow) throw new Error("Expected nested todo rows");
  expect(childRow.contains(grandchildRow)).toBe(true);
  expect(within(childRow).queryByText("Ship")).not.toBeInTheDocument();
  const collapse = screen.getByRole("button", { name: "Collapse Ship" });
  await userEvent.setup().click(collapse);
  expect(
    screen.queryByRole("checkbox", { name: "Build" }),
  ).not.toBeInTheDocument();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Expand Ship" }));
  await userEvent
    .setup()
    .click(screen.getByRole("checkbox", { name: "Build" }));
  await saved();
  expect(f.canvas.save).toHaveBeenCalledWith(
    context.channelId,
    content.replace("[ ] Build", "[x] Build"),
    head.id,
    { preserveApproval: true },
  );
  expect(screen.getByRole("checkbox", { name: "Ship" })).toHaveAttribute(
    "aria-checked",
    "mixed",
  );
});
it("adds and checks tasks, saves exact base, preserves other Markdown and restores saved content", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const view = render(<TodosPanel {...f.props} />);
  await screen.findByRole("checkbox", { name: "First" });
  expect(
    screen.queryByRole("button", { name: /^Retry$/ }),
  ).not.toBeInTheDocument();
  const input = screen.getByRole("textbox", { name: "New todo" });
  await user.type(input, "New item{Enter}");
  expect(input).toHaveFocus();
  await user.click(screen.getByRole("checkbox", { name: "New item" }));
  expect(screen.getByRole("checkbox", { name: "New item" })).toHaveFocus();
  await saved();
  expect(f.canvas.save).toHaveBeenLastCalledWith(
    context.channelId,
    original.replace("## Todos", "## Todos\n\n- [x] New item\n"),
    "b".repeat(64),
    { preserveApproval: true },
  );
  expect(
    readView(context.scope, `todos-draft-v1:${context.channelId}`, null),
  ).toBeNull();
  view.unmount();
  render(<TodosPanel {...f.props} />);
  expect(
    await screen.findByRole("checkbox", { name: "New item" }),
  ).toBeChecked();
});
it("moves a task through To do, In progress and Done, editing only its Canvas marker", async () => {
  const f = fixture(),
    user = userEvent.setup();
  render(<TodosPanel {...f.props} />);
  const status = () => screen.getByRole("button", { name: "Status for First" });
  const choose = async (name: string) => {
    await user.click(status());
    await user.click(await screen.findByRole("menuitemradio", { name }));
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
  };
  const section = (name: string) =>
    within(screen.getByRole("region", { name }));
  const lastSave = (content: string, base: string) =>
    expect(f.canvas.save).toHaveBeenLastCalledWith(
      context.channelId,
      content,
      base,
      { preserveApproval: true },
    );
  await screen.findByRole("checkbox", { name: "First" });
  expect(
    screen.queryByRole("region", { name: "In progress" }),
  ).not.toBeInTheDocument();
  expect(status()).toHaveAttribute("aria-description", "Status");
  await choose("In progress");
  await saved();
  lastSave(original.replace("- [ ] First", "- [/] First"), head.id);
  expect(
    section("In progress").getByRole("checkbox", { name: "First" }),
  ).toBePartiallyChecked();
  expect(status()).toHaveAttribute("aria-description", "Status");
  expect(status()).toHaveFocus();
  await choose("To do");
  await saved();
  lastSave(original, "b".repeat(64));
  expect(
    section("To do").getByRole("checkbox", { name: "First" }),
  ).not.toBeChecked();
  await choose("In progress");
  await saved();
  await user.click(screen.getByRole("checkbox", { name: "First" }));
  await saved();
  lastSave(original.replace("- [ ] First", "- [x] First"), "b".repeat(64));
  expect(
    section("Done").getByRole("checkbox", { name: "First" }),
  ).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "First" })).toHaveFocus();
});
it("keeps failed save changes through close/reopen and confirms destructive refresh", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const view = render(<TodosPanel {...f.props} />);
  await screen.findByRole("checkbox", { name: "First" });
  f.external();
  await user.click(screen.getByRole("checkbox", { name: "First" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Canvas changed elsewhere",
  );
  expect(
    screen.queryByRole("button", { name: /^Retry$/ }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  view.unmount();
  render(<TodosPanel {...f.props} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Canvas changed elsewhere",
  );
  expect(screen.getByRole("checkbox", { name: "First" })).toBeChecked();
  expect(
    screen.queryByRole("button", { name: /^Retry$/ }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByRole("checkbox", { name: "First" })).toBeChecked();
  expect(screen.getByRole("button", { name: "Refresh" })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await user.click(
    await screen.findByRole("button", { name: "Discard and refresh" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: "First" })).not.toBeChecked(),
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it("retrying a failed read preserves a restored draft without asking to discard", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const view = render(<TodosPanel {...f.props} />);
  f.canvas.save.mockRejectedValueOnce(new Error("Offline"));
  await user.click(await screen.findByRole("checkbox", { name: "First" }));
  await screen.findByRole("alert");
  view.unmount();
  f.canvas.read.mockRejectedValueOnce(new Error("Offline"));
  render(<TodosPanel {...f.props} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(retry()).toBeEnabled());
  expect(screen.getByRole("checkbox", { name: "First" })).toBeChecked();
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});
it("ignores retired reads and reconciles a save completed after unmount without resubmission", async () => {
  const f = fixture(),
    user = userEvent.setup();
  let release!: (value: typeof head) => void;
  const pending = new Promise<typeof head>((resolve) => {
    release = resolve;
  });
  f.canvas.read.mockReturnValueOnce(pending);
  const view = render(
    <StrictMode>
      <TodosPanel {...f.props} />
    </StrictMode>,
  );
  await screen.findByRole("checkbox", { name: "First" });
  await act(async () => {
    release({ ...head, content: "Old read" });
    await pending;
  });
  expect(screen.getByRole("checkbox", { name: "First" })).not.toBeChecked();
  const actualSave = f.canvas.save.getMockImplementation();
  if (!actualSave) throw new Error("Expected fixture save");
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.canvas.save.mockImplementationOnce(async (...args) => {
    await gate;
    return actualSave(...args);
  });
  await user.click(screen.getByRole("checkbox", { name: "First" }));
  expect(screen.getByRole("status")).toHaveTextContent("Saving");
  expect(screen.getByRole("checkbox", { name: "First" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  view.unmount();
  await act(async () => {
    finish();
    await gate;
  });
  render(<TodosPanel {...f.props} />);
  expect(await screen.findByRole("checkbox", { name: "First" })).toBeChecked();
  expect(
    screen.queryByRole("button", { name: /^Retry$/ }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(f.canvas.save).toHaveBeenCalledTimes(1);
});
it("fences new writes after plugin retirement and isolates channel drafts", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const view = render(<TodosPanel {...f.props} />);
  await screen.findByRole("checkbox", { name: "First" });
  f.retire();
  await user.click(screen.getByRole("checkbox", { name: "First" }));
  expect(f.canvas.save).not.toHaveBeenCalled();
  view.unmount();
  render(
    <TodosPanel
      {...fixture().props}
      context={{ ...context, channelId: "different" }}
    />,
  );
  expect(
    await screen.findByRole("checkbox", { name: "First" }),
  ).not.toBeChecked();
  expect(
    screen.queryByRole("button", { name: /^Retry$/ }),
  ).not.toBeInTheDocument();
});
it("exposes malformed sections and unavailable hosts without permitting writes", async () => {
  const f = fixture();
  f.canvas.available = false;
  f.canvas.read.mockResolvedValue({ ...head, content: "## Todos\n\n## Todos" });
  render(<TodosPanel {...f.props} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "more than one Todos",
  );
  expect(screen.getByRole("textbox", { name: "New todo" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: /^Retry$/ }),
  ).not.toBeInTheDocument();
});
function listedAs(access: Partial<ChannelSummary>) {
  let roster: ChannelList = {
    status: "ready",
    channels: [{ id: context.channelId, name: "Team", members: [], ...access }],
  };
  const listeners = new Set<() => void>();
  return {
    people: {
      ...people,
      channels: {
        ...people.channels,
        list: () => roster,
        subscribeList: (listener: () => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    },
    update(next: ChannelList) {
      roster = next;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}
it.each<Partial<ChannelSummary>>([
  { readOnly: true, viewerRole: "guest" },
  { archived: true },
])("shows Todos read-only without Canvas write access: %o", async (access) => {
  const f = fixture(),
    user = userEvent.setup();
  render(<TodosPanel {...f.props} people={listedAs(access).people} />);
  const first = await screen.findByRole("checkbox", { name: "First" });
  expect(screen.getByRole("textbox", { name: "New todo" })).toBeDisabled();
  expect(screen.getByRole("button", { name: /^Add$/ })).toBeDisabled();
  expect(first).toHaveAttribute("aria-disabled", "true");
  expect(
    screen.getByRole("button", { name: "Status for First" }),
  ).toBeDisabled();
  expect(
    within(
      screen.getByRole("group", { name: /^Assignee for First/ }),
    ).getByRole("button"),
  ).toBeDisabled();
  expect(screen.getByText("Todos are read-only.")).toHaveAttribute(
    "role",
    "status",
  );
  await user.click(first);
  expect(first).not.toBeChecked();
  expect(f.canvas.save).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: /^Retry$/ }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "About todos" }));
  expect(
    await screen.findByText(/^Todos are shared in this channel’s Canvas\./),
  ).toHaveTextContent(
    "Todos are shared in this channel’s Canvas. Refresh to load others’ changes.",
  );
});
it("omits the add hint from a read-only empty list", async () => {
  const f = fixture();
  f.canvas.read.mockResolvedValue({ ...head, content: "" });
  render(
    <TodosPanel {...f.props} people={listedAs({ archived: true }).people} />,
  );
  expect(await screen.findByText("No todos yet")).toBeInTheDocument();
  expect(screen.queryByText(/Add a todo above/)).not.toBeInTheDocument();
});
it("keeps a waiting save local when the channel is archived before it writes", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(1700000000250);
  const f = fixture();
  f.canvas.read.mockResolvedValue({ ...head, created_at: 1700000000 });
  const roster = listedAs({});
  render(<TodosPanel {...f.props} people={roster.people} />);
  await act(async () => {});
  act(() => screen.getByRole("checkbox", { name: "First" }).click());
  expect(screen.getByRole("status")).toHaveTextContent("Saving…");
  // The capability's canWrite ignores archived, so only Todos can stop this.
  roster.update({
    status: "ready",
    channels: [
      { id: context.channelId, name: "Team", members: [], archived: true },
    ],
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(f.canvas.save).not.toHaveBeenCalled();
  expect(
    readView(context.scope, `todos-draft-v1:${context.channelId}`, null),
  ).toEqual({
    content: original.replace("[ ] First", "[x] First"),
    original,
    base: head.id,
    input: "",
  });
  expect(screen.getByText("Unsaved changes")).toHaveAttribute("role", "status");
  expect(screen.getByText(localDraft)).toHaveAttribute("role", "status");
  expect(screen.getByRole("checkbox", { name: "First" })).toBeChecked();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it("lets a read-only guest discard a conflicting stored draft without writing", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const key = `todos-draft-v1:${context.channelId}`;
  writeView(context.scope, key, {
    content: original.replace("[ ] First", "[x] First"),
    original,
    base: "c".repeat(64), // An older revision than head.
    input: "",
  });
  render(
    <TodosPanel
      {...f.props}
      people={listedAs({ readOnly: true, viewerRole: "guest" }).people}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Canvas changed elsewhere. Refresh to load the latest todos. Your changes are kept until then.",
  );
  expect(screen.getByRole("checkbox", { name: "First" })).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Refresh todos" }));
  await user.click(
    await screen.findByRole("button", { name: "Discard and refresh" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: "First" })).not.toBeChecked(),
  );
  expect(readView(context.scope, key, null)).toBeNull();
  expect(f.canvas.save).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByText(localDraft)).not.toBeInTheDocument();
});
it("keeps a stored draft while read-only and offers Retry when writing returns", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const key = `todos-draft-v1:${context.channelId}`;
  const draft = {
    content: original.replace("[ ] First", "[x] First"),
    original,
    base: head.id,
    input: "Still typing",
  };
  writeView(context.scope, key, draft);
  // Startup: the channel is unlisted, then listed from cached membership.
  const roster = listedAs({});
  roster.update({ status: "loading", channels: [] });
  render(<TodosPanel {...f.props} people={roster.people} />);
  expect(await screen.findByRole("checkbox", { name: "First" })).toBeChecked();
  expect(screen.getByText(localDraft)).toBeInTheDocument();
  expect(readView(context.scope, key, null)).toEqual(draft);
  roster.update({
    status: "ready",
    channels: [
      {
        id: context.channelId,
        name: "Team",
        members: [],
        readOnly: true,
        cached: true,
      },
    ],
  });
  expect(screen.getByText(localDraft)).toHaveAttribute("role", "status");
  expect(
    screen.queryByRole("button", { name: /^Retry$/ }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  const input = screen.getByRole("textbox", { name: "New todo" });
  expect(input).toHaveValue("Still typing");
  // Submitting the form while read-only must not write.
  fireEvent.submit(input);
  expect(f.canvas.save).not.toHaveBeenCalled();
  expect(readView(context.scope, key, null)).toEqual(draft);
  roster.update({
    status: "ready",
    channels: [{ id: context.channelId, name: "Team", members: [] }],
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Recovered unsaved changes. Retry to save them to Canvas.",
  );
  expect(screen.queryByText("Todos are read-only.")).not.toBeInTheDocument();
  expect(screen.queryByText(localDraft)).not.toBeInTheDocument();
  await user.click(retry());
  await saved();
  expect(f.canvas.save).toHaveBeenCalledExactlyOnceWith(
    context.channelId,
    draft.content,
    head.id,
    { preserveApproval: true },
  );
  expect(input).toHaveValue("Still typing");
});

it("rebases an input-only recovery draft without discarding the typed item", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const view = render(<TodosPanel {...f.props} />);
  await screen.findByRole("checkbox", { name: "First" });
  await user.type(
    screen.getByRole("textbox", { name: "New todo" }),
    "Still typing",
  );
  view.unmount();
  f.external();
  render(<TodosPanel {...f.props} />);
  await screen.findByRole("checkbox", { name: "First" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "New todo" })).toHaveValue(
    "Still typing",
  );
  await user.click(screen.getByRole("button", { name: /^Add$/ }));
  await saved();
  expect(f.canvas.save).toHaveBeenCalledWith(
    context.channelId,
    expect.stringContaining("Remote edit."),
    "c".repeat(64),
    { preserveApproval: true },
  );
});
it("keeps the editor usable when local recovery storage is unavailable", async () => {
  const f = fixture(),
    user = userEvent.setup();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage full");
  });
  render(<TodosPanel {...f.props} />);
  await user.click(await screen.findByRole("checkbox", { name: "First" }));
  await saved();
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Saved in Canvas"),
  );
  expect(f.canvas.save).toHaveBeenCalledTimes(1);
});

it("keeps exact assignees through rename, failed-save recovery and member removal, then clears", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const a = "a".repeat(64),
    b = "b".repeat(64);
  let roster: ChannelList = {
    status: "ready" as const,
    channels: [{ id: context.channelId, name: "Team", members: [a, b] }],
  };
  let profiles = new Map([
    [a, { name: "Alex" }],
    [b, { name: "Alex" }],
  ]);
  const labels = publicKeyLabels([a, b]);
  const rosterListeners = new Set<() => void>(),
    profileListeners = new Set<() => void>();
  const directory = {
    snapshot: () => profiles,
    subscribe: (listener: () => void) => {
      profileListeners.add(listener);
      return () => {
        profileListeners.delete(listener);
      };
    },
    ensure: vi.fn(async () => {}),
  };
  const names = bindNames({
    profiles: directory,
    agentLibrary: session.agentLibrary,
  });
  const users = {
    media: session.media,
    profiles: directory,
    names,
    channels: {
      ...people.channels,
      list: () => roster,
      subscribeList: (listener: () => void) => {
        rosterListeners.add(listener);
        return () => {
          rosterListeners.delete(listener);
        };
      },
    },
  };
  const select = () =>
    within(
      screen.getByRole("group", { name: /^Assignee for First/ }),
    ).getByRole("button");
  const view = render(<TodosPanel {...f.props} people={users} />);
  await screen.findByRole("checkbox", { name: "First" });
  f.canvas.save.mockRejectedValueOnce(new Error("Offline"));
  await user.click(select());
  expect(
    await screen.findByRole("menuitemradio", {
      name: `Alex · ${labels.get(a)}`,
    }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("menuitemradio", { name: `Alex · ${labels.get(b)}` }),
  ).toBeInTheDocument();
  await user.click(
    screen.getByRole("menuitemradio", { name: `Alex · ${labels.get(a)}` }),
  );
  const expected = assignTodo(
    original,
    readTodos(original).items[0]?.offset ?? -1,
    {
      pubkey: a,
      name: "Alex",
    },
  );
  await screen.findByRole("alert");
  view.unmount();
  const restored = render(<TodosPanel {...f.props} people={users} />);
  await screen.findByRole("checkbox", { name: "First" });
  expect(select()).toHaveAttribute(
    "aria-description",
    expect.stringContaining("Alex"),
  );
  expect(select().querySelector("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
  act(() => {
    profiles = new Map([
      [a, { name: "Renamed" }],
      [b, { name: "Alex" }],
    ]);
    for (const listener of profileListeners) listener();
  });
  expect(select()).toHaveAttribute(
    "aria-description",
    expect.stringContaining("Renamed"),
  );
  await user.click(retry());
  await saved();
  expect(f.canvas.save).toHaveBeenLastCalledWith(
    context.channelId,
    expected,
    head.id,
    { preserveApproval: true },
  );
  act(() => {
    roster = {
      ...roster,
      channels: [{ id: context.channelId, name: "Team", members: [b] }],
    };
    for (const listener of rosterListeners) listener();
  });
  expect(select()).toHaveAttribute(
    "aria-description",
    expect.stringContaining("Renamed"),
  );
  expect(
    screen.queryByRole("button", { name: /^Retry$/ }),
  ).not.toBeInTheDocument();
  act(() => select().focus());
  await user.keyboard("{ArrowDown}");
  expect(
    await screen.findByRole("menuitemradio", { name: /not in channel/ }),
  ).toHaveAttribute("aria-disabled", "true");
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Unassigned" }),
  );
  await saved();
  expect(f.canvas.save).toHaveBeenLastCalledWith(
    context.channelId,
    original,
    "b".repeat(64),
    { preserveApproval: true },
  );
  restored.unmount();
  names.dispose();
  expect(rosterListeners.size).toBe(0);
  expect(profileListeners.size).toBe(0);
});
it("shows saved identity when profiles fail, disables missing-roster assignments and rejects stale membership selections", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const a = "a".repeat(64);
  let roster: ChannelList = {
    status: "ready" as const,
    channels: [
      {
        id: context.channelId,
        name: "Team",
        members: [a, "b".repeat(64)],
      },
    ],
  };
  const users = {
    ...people,
    channels: { ...people.channels, list: () => roster },
    profiles: {
      ...people.profiles,
      ensure: vi.fn(async () => {
        throw new Error("Offline");
      }),
    },
  };
  const saved = assignTodo(
    original,
    readTodos(original).items[0]?.offset ?? -1,
    {
      pubkey: a,
      name: "Saved name",
    },
  );
  f.canvas.read.mockResolvedValue({ ...head, content: saved });
  const view = render(<TodosPanel {...f.props} people={users} />);
  const select = () =>
    within(
      screen.getByRole("group", { name: /^Assignee for First/ }),
    ).getByRole("button");
  await screen.findByRole("checkbox", { name: "First" });
  expect(select()).toHaveAttribute(
    "aria-description",
    expect.stringContaining("Saved name"),
  );
  await screen.findByText(/Names unavailable/);
  await user.click(screen.getByRole("button", { name: "Retry users" }));
  await waitFor(() => expect(users.profiles.ensure).toHaveBeenCalledTimes(2));
  // Captured option is stale; the click must read the current authoritative roster.
  act(() => select().focus());
  await user.keyboard("{ArrowDown}");
  const stale = await screen.findByRole("menuitemradio", {
    name:
      publicKeyLabels([a, "b".repeat(64)]).get("b".repeat(64)) ??
      "missing fixture label",
  });
  roster = {
    ...roster,
    channels: [{ id: context.channelId, name: "Team", members: [] }],
  };
  await user.click(stale);
  expect(
    screen.queryByRole("button", { name: /^Retry$/ }),
  ).not.toBeInTheDocument();
  roster = {
    ...roster,
    channels: [{ id: context.channelId, name: "Team" }],
  };
  view.rerender(<TodosPanel {...f.props} people={users} />);
  expect(select()).toBeDisabled();
  expect(select()).toHaveAttribute(
    "aria-description",
    expect.stringContaining("Saved name"),
  );
  expect(
    screen.getByText("Channel members unavailable or out of date."),
  ).toBeInTheDocument();
});

it("waits for the next Canvas second, saves once and cancels a pending wait on close", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(1700000000250);
  const f = fixture();
  f.canvas.read.mockResolvedValue({ ...head, created_at: 1700000000 });
  const view = render(<TodosPanel {...f.props} />);
  await act(async () => {});
  act(() => screen.getByRole("checkbox", { name: "First" }).click());
  expect(screen.getByRole("status")).toHaveTextContent("Saving…");
  expect(f.canvas.save).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(749);
  });
  expect(f.canvas.save).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(f.canvas.save).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status")).toHaveTextContent("Saved in Canvas");
  view.unmount();
  localStorage.clear();
  const pending = fixture();
  pending.canvas.read.mockResolvedValue({ ...head, created_at: 1700000001 });
  const closing = render(<TodosPanel {...pending.props} />);
  await act(async () => {});
  act(() => screen.getByRole("checkbox", { name: "First" }).click());
  expect(screen.getByRole("status")).toHaveTextContent("Saving…");
  closing.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(pending.canvas.save).not.toHaveBeenCalled();
  expect(
    readView<{ content: string }>(
      context.scope,
      `todos-draft-v1:${context.channelId}`,
      { content: "" },
    ).content,
  ).toContain("- [x] First");
});

it("retains failed autosaves for explicit retry, without writing typed input or retrying on reopen", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const view = render(<TodosPanel {...f.props} />);
  await screen.findByRole("checkbox", { name: "First" });
  await user.type(
    screen.getByRole("textbox", { name: "New todo" }),
    "Still typing",
  );
  expect(f.canvas.save).not.toHaveBeenCalled();
  f.canvas.save.mockRejectedValueOnce(new Error("Offline"));
  await user.click(screen.getByRole("checkbox", { name: "First" }));
  await screen.findByRole("alert");
  expect(f.canvas.save).toHaveBeenCalledTimes(1);
  view.unmount();
  render(<TodosPanel {...f.props} />);
  await screen.findByText(/Recovered unsaved changes/);
  expect(f.canvas.save).toHaveBeenCalledTimes(1);
  await user.click(retry());
  await saved();
  expect(f.canvas.save).toHaveBeenCalledTimes(2);
  expect(f.canvas.save.mock.calls[1]).toEqual(f.canvas.save.mock.calls[0]);
  expect(screen.getByRole("textbox", { name: "New todo" })).toHaveValue(
    "Still typing",
  );
});

it("scopes live naming to channel members rather than out-of-channel namesakes", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const a = "a".repeat(64),
    outside = "b".repeat(64);
  const profiles = new Map([
    [a, { name: "Alex" }],
    [outside, { name: "Alex" }],
  ]);
  const roster = {
    status: "ready" as const,
    channels: [{ id: context.channelId, name: "Team", members: [a] }],
  };
  const directory = {
    snapshot: () => profiles,
    subscribe: () => () => {},
    ensure: async () => {},
  };
  const names = bindNames(
    { profiles: directory, agentLibrary: session.agentLibrary },
    {
      snapshot: () => [agentDirectory],
      subscribe: () => () => {},
    },
  );
  expect(names.resolve(a, "")).not.toBe("Alex");
  const users = {
    ...people,
    profiles: directory,
    names,
    channels: { ...people.channels, list: () => roster },
  };
  const content = assignTodo(
    original,
    readTodos(original).items[0]?.offset ?? -1,
    { pubkey: a, name: "Alex" },
  );
  f.canvas.read.mockResolvedValue({ ...head, content });
  const view = render(<TodosPanel {...f.props} people={users} />);
  await screen.findByRole("checkbox", { name: "First" });
  const trigger = screen.getByRole("button", { name: /^Assignee for First/ });
  expect(trigger).toHaveAttribute(
    "aria-description",
    expect.stringContaining("Alex"),
  );
  await user.click(trigger);
  expect(
    await screen.findByRole("menuitemradio", {
      name: `Alex · ${publicKeyLabels([a]).get(a)}`,
    }),
  ).toBeInTheDocument();
  expect(screen.getAllByRole("menuitemradio")).toHaveLength(2);
  view.unmount();
  names.dispose();
});

it.each([
  ["valid", original],
  ["malformed", "## Todos\n\n## Todos"],
])(
  "reuses parsing results and errors for unchanged Canvas content: %s",
  async (_label, content) => {
    const f = fixture(),
      user = userEvent.setup();
    const parse = vi.spyOn(model, "readTodos");
    f.canvas.read.mockResolvedValue({ ...head, content });
    const view = render(<TodosPanel {...f.props} />);
    await saved();
    const baseline = parse.mock.calls.length;
    if (content === original) {
      const input = screen.getByRole("textbox", { name: "New todo" });
      await user.type(input, "Eggs");
      await user.clear(input);
    } else {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "more than one Todos",
      );
    }
    view.rerender(
      <TodosPanel
        {...f.props}
        context={{ ...context, channelName: "Renamed" }}
      />,
    );
    expect(parse).toHaveBeenCalledTimes(baseline);
    expect(f.canvas.save).not.toHaveBeenCalled();
    const changed = "## Todos\n- [ ] Changed";
    f.canvas.read.mockResolvedValue({ ...head, content: changed });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByRole("checkbox", { name: "Changed" });
    expect(parse).toHaveBeenCalledTimes(baseline + 1);
    expect(parse).toHaveBeenLastCalledWith(changed);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  },
);

it.each(["success", "failure", "closed"])(
  "retains next-item typing through a pending autosave: %s",
  async (outcome) => {
    const f = fixture(),
      user = userEvent.setup();
    const actualSave = f.canvas.save.getMockImplementation();
    if (!actualSave) throw new Error("Expected fixture save");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.canvas.save.mockImplementationOnce(async (...args) => {
      await gate;
      if (outcome === "failure") throw new Error("Offline");
      return actualSave(...args);
    });
    const view = render(<TodosPanel {...f.props} />);
    await screen.findByRole("checkbox", { name: "First" });
    const input = screen.getByRole("textbox", { name: "New todo" });
    try {
      await user.type(input, "Milk{Enter}");
      await waitFor(() => expect(f.canvas.save).toHaveBeenCalledTimes(1));
      expect(screen.getByRole("status")).toHaveTextContent("Saving");
      expect(input).toBeEnabled();
      expect(input).toHaveFocus();
      await user.type(input, "Eggs{Enter}");
      expect(input).toHaveValue("Eggs");
      expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
      expect(screen.getByRole("checkbox", { name: "Milk" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(
        screen.getByRole("button", { name: "Assignee for Milk" }),
      ).toBeDisabled();
      await user.click(screen.getByRole("button", { name: "Add" }));
      expect(f.canvas.save).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByRole("checkbox", { name: "Eggs" }),
      ).not.toBeInTheDocument();
      expect(
        readView(context.scope, `todos-draft-v1:${context.channelId}`, null),
      ).toEqual(
        expect.objectContaining({
          input: "Eggs",
          content: expect.stringContaining("- [ ] Milk"),
        }),
      );
      if (outcome === "closed") view.unmount();
    } finally {
      await act(async () => {
        release();
        await f.canvas.save.mock.results[0]?.value.catch(() => {});
      });
    }
    if (outcome !== "closed") {
      if (outcome === "failure")
        await screen.findByText(/Your changes are still here/);
      else await saved();
      expect(input).toHaveValue("Eggs");
      expect(input).toHaveFocus();
      view.unmount();
    }
    render(<TodosPanel {...f.props} />);
    await screen.findByRole("checkbox", { name: "Milk" });
    expect(screen.getByRole("textbox", { name: "New todo" })).toHaveValue(
      "Eggs",
    );
    expect(f.canvas.save).toHaveBeenCalledTimes(1);
    if (outcome === "failure") {
      await screen.findByText(/Recovered unsaved changes/);
      await user.click(retry());
      await saved();
      expect(screen.getByRole("textbox", { name: "New todo" })).toHaveValue(
        "Eggs",
      );
      expect(f.canvas.save).toHaveBeenCalledTimes(2);
    }
    expect(
      readView(context.scope, `todos-draft-v1:${context.channelId}`, null),
    ).toEqual(
      expect.objectContaining({
        input: "Eggs",
        base: "b".repeat(64),
        original: expect.stringContaining("- [ ] Milk"),
      }),
    );
    await user.click(screen.getByRole("button", { name: "Add" }));
    await saved();
    expect(screen.getByRole("checkbox", { name: "Eggs" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "New todo" })).toHaveValue("");
    expect(f.canvas.save).toHaveBeenCalledTimes(outcome === "failure" ? 3 : 2);
  },
);

it("updates the assigned avatar from live profiles through the session media owner", async () => {
  const f = fixture();
  const pubkey = "a".repeat(64);
  let profiles: ReturnType<typeof people.profiles.snapshot> = new Map([
    [pubkey, { name: "Alex", picture: "https://art.test/first.png" }],
  ]);
  const listeners = new Set<() => void>();
  const media = vi.fn((picture: string) =>
    picture.replace("https://art.test", "/media"),
  );
  const users = {
    ...people,
    media,
    profiles: {
      ...people.profiles,
      snapshot: () => profiles,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      ensure: async () => {},
    },
  };
  f.canvas.read.mockResolvedValue({
    ...head,
    content: assignTodo(original, readTodos(original).items[0]?.offset ?? -1, {
      pubkey,
      name: "Alex",
    }),
  });
  const view = render(<TodosPanel {...f.props} people={users} />);
  await screen.findByRole("checkbox", { name: "First" });
  const trigger = screen.getByRole("button", { name: /^Assignee for First/ });
  expect(trigger.querySelector("img")).toHaveAttribute(
    "src",
    "/media/first.png",
  );
  expect(media).toHaveBeenCalledWith("https://art.test/first.png", "small");
  expect(trigger.querySelector("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
  act(() => {
    profiles = new Map([
      [
        pubkey,
        {
          name: "Alex",
          picture: "https://art.test/updated.png",
          isAgent: true,
        },
      ],
    ]);
    for (const listener of listeners) listener();
  });
  expect(trigger.querySelector("img")).toHaveAttribute(
    "src",
    "/media/updated.png",
  );
  expect(trigger.querySelector("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  expect(f.canvas.save).not.toHaveBeenCalled();
  view.unmount();
  expect(listeners.size).toBe(0);
});

it("preserves actionable save failure details", async () => {
  const f = fixture();
  f.canvas.save.mockRejectedValueOnce(
    new Error(`Keep Canvas below ${LIVE_CANVAS_LIMIT}`),
  );
  render(<TodosPanel {...f.props} />);
  await screen.findByRole("checkbox", { name: "First" });
  await userEvent
    .setup()
    .click(screen.getByRole("checkbox", { name: "First" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    `Keep Canvas below ${LIVE_CANVAS_LIMIT}`,
  );
});

it("renders task Markdown outside checkbox labels and shows a legacy named assignee", async () => {
  const f = fixture();
  f.canvas.read.mockResolvedValue({
    ...head,
    content:
      "## Todos\n\n- [ ] **Ship** [release](https://example.com) · Assignee: John\n",
  });
  render(<TodosPanel {...f.props} />);
  const link = await screen.findByRole("link", { name: "release" });
  expect(link.closest("label")).toBeNull();
  expect(screen.getByText("Ship").tagName).toBe("STRONG");
  expect(screen.queryByText(/Assignee: John/)).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /Assignee for/ }),
  ).toHaveTextContent("John");
  expect(screen.getByRole("button", { name: /Assignee for/ })).toHaveAttribute(
    "aria-description",
    "John (from Canvas; choose a member to link)",
  );
});

it("routes copied Buzz links and filters unsupported task destinations", async () => {
  const f = fixture();
  const message = `buzz://channel/general/${"a".repeat(64)}`;
  f.canvas.read.mockResolvedValue({
    ...head,
    content: `## Todos\n\n- [ ] Review [channel](buzz://channel/general) and [message](${message}) and [website](https://example.com) and [relative](/settings) and [credentials](https://user:pass@example.com) and [invalid](buzz://bad/path)\n`,
  });
  render(<TodosPanel {...f.props} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("link", { name: "channel" }));
  expect(f.props.onOpenLink).toHaveBeenLastCalledWith("buzz://channel/general");
  await user.click(screen.getByRole("link", { name: "message" }));
  expect(f.props.onOpenLink).toHaveBeenLastCalledWith(message);
  expect(screen.getByRole("link", { name: "website" })).toHaveAttribute(
    "href",
    "https://example.com/",
  );
  for (const name of ["relative", "credentials", "invalid"]) {
    expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
    expect(screen.getByText(name)).toBeInTheDocument();
  }
});
it("uses rendered Markdown and the displayed assignee in accessible names", async () => {
  const f = fixture();
  f.canvas.read.mockResolvedValue({
    ...head,
    content:
      "## Todos\n\n- [ ] **Build** [release](https://example.com) · Assignee: John\n    - [ ] Child\n",
  });
  render(<TodosPanel {...f.props} />);
  await screen.findByRole("checkbox", { name: "Build release" });
  expect(
    screen.getByRole("button", { name: "Collapse Build release" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Status for Build release" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Assignee for Build release: John" }),
  ).toHaveTextContent("John");
});
it("keeps a later subtree collapsed after adding and assigning an earlier task", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const content =
    "## Todos\n\n- [ ] Earlier · Assignee: John\n- [ ] Parent\n    - [ ] Child\n";
  f.canvas.read.mockResolvedValue({ ...head, content });
  render(<TodosPanel {...f.props} />);
  await user.click(
    await screen.findByRole("button", { name: "Collapse Parent" }),
  );
  await user.type(
    screen.getByRole("textbox", { name: "New todo" }),
    "Inserted{Enter}",
  );
  await saved();
  expect(
    screen.getByRole("button", { name: "Expand Parent" }),
  ).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: /^Assignee for Earlier/ }),
  );
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Unassigned" }),
  );
  await saved();
  expect(
    screen.getByRole("button", { name: "Expand Parent" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("checkbox", { name: "Child" }),
  ).not.toBeInTheDocument();
});

it("keeps a later subtree collapsed when removing an earlier assignment", async () => {
  const f = fixture(),
    user = userEvent.setup();
  f.canvas.read.mockResolvedValue({
    ...head,
    content:
      "## Todos\n\n- [ ] Earlier · Assignee: John\n- [ ] Parent\n    - [ ] Child\n",
  });
  render(<TodosPanel {...f.props} />);
  await user.click(
    await screen.findByRole("button", { name: "Collapse Parent" }),
  );
  await user.click(
    screen.getByRole("button", { name: /^Assignee for Earlier/ }),
  );
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Unassigned" }),
  );
  await saved();
  expect(
    screen.getByRole("button", { name: "Expand Parent" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("checkbox", { name: "Child" }),
  ).not.toBeInTheDocument();
});
it("clears collapsed positions when refreshing a changed Canvas", async () => {
  const f = fixture(),
    user = userEvent.setup();
  f.canvas.read.mockResolvedValue({
    ...head,
    content: "## Todos\n\n- [ ] Parent\n    - [ ] Child\n",
  });
  render(<TodosPanel {...f.props} />);
  await user.click(
    await screen.findByRole("button", { name: "Collapse Parent" }),
  );
  f.canvas.read.mockResolvedValue({
    ...head,
    content: "## Todos\n\n- [ ] Other!\n    - [ ] New child\n",
  });
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  expect(
    await screen.findByRole("checkbox", { name: "New child" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Collapse Other!" }),
  ).toBeInTheDocument();
});
