// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextMenuRoot, MenuPopup } from "../../shared/design-system/ui/Menu";
import {
  ChannelLifecycleUnconfirmed,
  type ChannelLifecycleCapability,
} from "../../features/relay/channel-lifecycle";
import { ChannelLifecycleMenu } from "./ChannelLifecycleMenu";
import { ChannelLifecycleDialog } from "./ChannelLifecycleDialog";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { ProfileQueries } from "../../features/relay/profile-directory";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function capability() {
  return {
    available: true,
    load: vi.fn<ChannelLifecycleCapability["load"]>(),
    run: vi.fn<ChannelLifecycleCapability["run"]>(async () => {}),
    snapshot: () => ({ status: "ready", hidden: [] }),
    subscribe: () => () => {},
    observeRemoval: () => () => {},
    refreshVisibility: async () => {},
  } satisfies ChannelLifecycleCapability;
}
const viewer = "a".repeat(64),
  other = "b".repeat(64),
  agent = "c".repeat(64);
function summary(overrides: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Fixture",
    channelType: "stream",
    viewerRole: "owner",
    members: [viewer, other],
    owners: [viewer],
    ...overrides,
  };
}
/** The session's profile cache: verified owners of the profiles it holds. */
function session(
  lifecycle: ChannelLifecycleCapability = capability(),
  held: Record<string, string> = {},
) {
  const listeners = new Set<() => void>();
  const owners = new Map(Object.entries(held));
  let evictions = 0;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    viewer,
    channelLifecycle: lifecycle,
    profiles: {
      snapshot: () => new Map(),
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      ensure: vi.fn(async (_ids: readonly string[], _priority?: string) => {}),
      event: (key: string) =>
        owners.has(key)
          ? ({} as ReturnType<NonNullable<ProfileQueries["event"]>>)
          : undefined,
      owner: (key: string) => owners.get(key),
      evictions: () => evictions,
    },
    hold(key: string, owner: string) {
      owners.set(key, owner);
      notify();
    },
    evict(key: string) {
      owners.delete(key);
      evictions++;
      notify();
    },
    /** A cache shrink cancelling a background read: nothing held changes. */
    cancel() {
      evictions++;
      notify();
    },
  };
}
function menu(
  channel: ChannelSummary,
  host = session(),
  props: Partial<Parameters<typeof ChannelLifecycleMenu>[0]> = {},
) {
  const choose = vi.fn();
  render(
    <ContextMenuRoot open>
      <MenuPopup>
        <ChannelLifecycleMenu
          channel={channel}
          session={host}
          choose={choose}
          disabled={false}
          separator
          {...props}
        />
      </MenuPopup>
    </ContextMenuRoot>,
  );
  return { choose, host };
}
it("offers permitted actions on first render, without a relay read, and keeps the last-owner boundary", async () => {
  const user = userEvent.setup();
  const lifecycle = capability();
  const { choose } = menu(summary(), session(lifecycle));
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual(["Archive channel", "Delete channel"]);
  expect(screen.getAllByRole("separator")).toHaveLength(1);
  expect(
    screen.queryByText("Transfer ownership before leaving the channel."),
  ).toBeNull();
  for (const item of screen.getAllByRole("menuitem"))
    expect(
      item.querySelector('.buzz-menu-icon[aria-hidden="true"] svg'),
    ).not.toBeNull();
  expect(lifecycle.load).not.toHaveBeenCalled();
  await user.click(screen.getByRole("menuitem", { name: "Delete channel" }));
  expect(choose).toHaveBeenCalledWith("delete");
  expect(lifecycle.run).not.toHaveBeenCalled();
});
it.each([
  {
    action: "leave",
    label: "Leave channel",
    channel: { viewerRole: "member", owners: [other] },
    items: ["Leave channel"],
  },
  {
    action: "hide",
    label: "Hide conversation",
    channel: { channelType: "dm", viewerRole: "member", owners: [] },
    items: ["Hide conversation"],
  },
  {
    action: "unarchive",
    label: "Unarchive channel",
    channel: { viewerRole: "admin", owners: [other], archived: true },
    items: ["Leave channel", "Unarchive channel"],
  },
] as const)(
  "offers $label without an ellipsis when permitted",
  async ({ action, label, channel, items }) => {
    const user = userEvent.setup();
    const { choose } = menu(summary(channel as Partial<ChannelSummary>));
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(items);
    await user.click(screen.getByRole("menuitem", { name: label }));
    expect(choose).toHaveBeenCalledWith(action);
  },
);
it.each([
  { separator: false, known: true },
  { separator: true, known: false },
])("omits an orphan separator: %j", ({ separator, known }) => {
  const { owners: _, ...unknown } = summary();
  menu(known ? summary() : unknown, session(), { separator });
  expect(screen.queryAllByRole("menuitem")).toHaveLength(known ? 2 : 0);
  expect(screen.queryByRole("separator")).toBeNull();
});
it("keeps the unavailable section separated without loading permissions", () => {
  const lifecycle = { ...capability(), available: false };
  menu(summary(), session(lifecycle));
  expect(
    screen.getByRole("menuitem", {
      name: "Channel actions unavailable on this connection",
    }),
  ).toBeDefined();
  expect(screen.getAllByRole("separator")).toHaveLength(1);
  expect(lifecycle.load).not.toHaveBeenCalled();
});
it("offers an owner-agent's human Archive and Delete from the profile cache", () => {
  const host = session(capability(), { [agent]: viewer });
  menu(summary({ viewerRole: "member", owners: [agent] }), host);
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual(["Leave channel", "Archive channel", "Delete channel"]);
  expect(host.profiles.ensure).not.toHaveBeenCalled();
});
it("fetches a missing owner profile in the background without holding back Leave", () => {
  const { host } = menu(summary({ viewerRole: "member", owners: [agent] }));
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual(["Leave channel"]);
  expect(host.profiles.ensure).toHaveBeenCalledExactlyOnceWith(
    [agent],
    "background",
  );
  act(() => host.hold(agent, other));
  expect(screen.getAllByRole("menuitem")).toHaveLength(1);
  act(() => host.hold(agent, viewer));
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual(["Leave channel", "Archive channel", "Delete channel"]);
});
it("fetches an evicted owner profile again instead of dropping owner-agent actions", () => {
  const host = session(capability(), { [agent]: viewer });
  menu(summary({ viewerRole: "member", owners: [agent] }), host);
  expect(host.profiles.ensure).not.toHaveBeenCalled();
  act(() => host.evict(agent));
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual(["Leave channel"]);
  expect(host.profiles.ensure).toHaveBeenCalledExactlyOnceWith(
    [agent],
    "background",
  );
  act(() => host.hold(agent, viewer));
  expect(screen.getAllByRole("menuitem")).toHaveLength(3);
});
it("fetches an owner profile again after a cache shrink cancels its read", () => {
  const { host } = menu(summary({ viewerRole: "member", owners: [agent] }));
  expect(host.profiles.ensure).toHaveBeenCalledOnce();
  act(() => host.cancel());
  expect(host.profiles.ensure).toHaveBeenCalledTimes(2);
  act(() => host.hold(agent, viewer));
  expect(screen.getAllByRole("menuitem")).toHaveLength(3);
});
it("asks again for an owner profile after a failed read, at the directory's next change", async () => {
  const host = session();
  let fail!: () => void;
  host.profiles.ensure.mockImplementationOnce(
    () =>
      new Promise<void>(
        (_, reject) => (fail = () => reject(new Error("offline"))),
      ),
  );
  menu(summary({ viewerRole: "member", owners: [agent] }), host);
  expect(host.profiles.ensure).toHaveBeenCalledOnce();
  await act(async () => fail());
  expect(host.profiles.ensure).toHaveBeenCalledOnce();
  act(() => host.hold(other, viewer));
  expect(host.profiles.ensure).toHaveBeenCalledTimes(2);
  act(() => host.hold(agent, viewer));
  expect(screen.getAllByRole("menuitem")).toHaveLength(3);
});
it("offers nothing and reads no profile for restored cached membership", () => {
  const { host } = menu(
    summary({ viewerRole: "member", owners: [agent], cached: true }),
  );
  expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  expect(host.profiles.ensure).not.toHaveBeenCalled();
});
it("dismisses confirmation into pending feedback, then reports a failed write without resubmitting", async () => {
  const user = userEvent.setup();
  const lifecycle = capability();
  const completed = vi.fn();
  const close = vi.fn();
  const gate = deferred<void>();
  lifecycle.run.mockImplementationOnce(() =>
    gate.promise.then(() => {
      throw new Error(
        "Relay rejected the request. Check permissions and try again.",
      );
    }),
  );
  render(
    <ToastProvider>
      <ChannelLifecycleDialog
        channelId="id"
        channelName="Fixture"
        action="delete"
        lifecycle={lifecycle}
        completed={completed}
        close={close}
      />
    </ToastProvider>,
  );
  const confirm = screen.getByRole("button", { name: "Delete channel" });
  expect(confirm).toHaveAttribute("data-variant", "destructive");
  expect(screen.getByRole("dialog", { name: "Delete Fixture?" })).toBeDefined();
  expect(
    screen.getByText(
      "This deletes the channel for everyone. You can’t undo this.",
    ),
  ).toBeDefined();
  expect(lifecycle.run).not.toHaveBeenCalled();
  await user.click(confirm);
  try {
    await screen.findByRole("dialog", { name: "Deleting channel…" });
    expect(screen.queryByRole("button", { name: "Delete channel" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Dismiss notification" }),
    ).toBeNull();
    await user.keyboard("{Escape}");
    expect(close).not.toHaveBeenCalled();
    expect(lifecycle.run).toHaveBeenCalledOnce();
  } finally {
    gate.resolve();
  }
  await screen.findByRole("dialog", { name: "Delete channel failed" });
  expect(
    screen.getByText(
      "Relay rejected the request. Check permissions and try again.",
    ),
  ).toBeVisible();
  expect(completed).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(lifecycle.run).toHaveBeenCalledOnce();
});

it("returns keyboard focus to the trigger while confirmed work continues in a toast", async () => {
  const lifecycle = capability();
  const gate = deferred<void>();
  lifecycle.run.mockImplementationOnce(() => gate.promise);
  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <ToastProvider>
        <button type="button" onClick={() => setOpen(true)}>
          Channel actions
        </button>
        {open && (
          <ChannelLifecycleDialog
            channelId="id"
            channelName="Fixture"
            action="delete"
            lifecycle={lifecycle}
            close={() => setOpen(false)}
            completed={() => setOpen(false)}
          />
        )}
      </ToastProvider>
    );
  }
  render(<Host />);
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Channel actions" });
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "Delete channel" }));
  try {
    await screen.findByRole("dialog", { name: "Deleting channel…" });
    await waitFor(() => expect(trigger).toHaveFocus());
  } finally {
    await act(async () => gate.resolve());
  }
});

it.each([
  ["delete", "Delete channel", "Deleting channel…", "Channel deleted"],
  ["leave", "Leave channel", "Leaving channel…", "Channel left"],
  ["hide", "Hide conversation", "Hiding conversation…", "Conversation hidden"],
  ["archive", "Archive channel", "Archiving channel…", "Channel archived"],
  [
    "unarchive",
    "Unarchive channel",
    "Unarchiving channel…",
    "Channel unarchived",
  ],
] as const)(
  "%s completes only after confirmation and leaves success feedback after its owner closes",
  async (action, label, pending, success) => {
    const lifecycle = capability();
    const gate = deferred<void>();
    lifecycle.run.mockImplementationOnce(() => gate.promise);
    const completed = vi.fn();
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <ToastProvider>
          {open && (
            <ChannelLifecycleDialog
              channelId="id"
              channelName="Fixture"
              action={action}
              lifecycle={lifecycle}
              close={() => setOpen(false)}
              completed={() => {
                completed();
                setOpen(false);
              }}
            />
          )}
        </ToastProvider>
      );
    }
    render(<Host />);
    expect(lifecycle.run).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole("button", { name: label }));
    try {
      await screen.findByRole("dialog", { name: pending });
      expect(lifecycle.run).toHaveBeenCalledWith(
        action,
        "id",
        expect.any(AbortSignal),
      );
      expect(completed).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    } finally {
      await act(async () => gate.resolve());
    }
    await screen.findByRole("dialog", { name: `${success}: Fixture` });
    expect(completed).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: pending })).toBeNull();
  },
);

it.each(["leave", "hide", "archive", "unarchive", "delete"] as const)(
  "%s aborts on owner unmount and clears pending feedback without a late success",
  async (action) => {
    const lifecycle = capability();
    const gate = deferred<void>();
    lifecycle.run.mockImplementationOnce(() => gate.promise);
    const completed = vi.fn();
    const view = render(
      <ToastProvider>
        <ChannelLifecycleDialog
          channelId="id"
          channelName="Fixture"
          action={action}
          lifecycle={lifecycle}
          close={vi.fn()}
          completed={completed}
        />
      </ToastProvider>,
    );
    const label = {
      leave: "Leave channel",
      hide: "Hide conversation",
      archive: "Archive channel",
      unarchive: "Unarchive channel",
      delete: "Delete channel",
    }[action];
    await userEvent.setup().click(screen.getByRole("button", { name: label }));
    const signal = lifecycle.run.mock.calls[0]?.[2];
    view.rerender(
      <ToastProvider>
        <p>Other channel</p>
      </ToastProvider>,
    );
    expect(signal?.aborted).toBe(true);
    await act(async () => gate.resolve());
    expect(completed).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);

it("uncertain delivery reports refresh guidance in a toast without offering blind resubmission", async () => {
  const lifecycle = capability();
  lifecycle.run.mockRejectedValueOnce(
    new ChannelLifecycleUnconfirmed("connection lost"),
  );
  const close = vi.fn();
  const completed = vi.fn();
  render(
    <ToastProvider>
      <ChannelLifecycleDialog
        channelId="id"
        channelName="Fixture"
        action="leave"
        lifecycle={lifecycle}
        close={close}
        completed={completed}
      />
    </ToastProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Leave channel" }));
  await screen.findByRole("dialog", { name: "Leave channel failed" });
  expect(screen.getByText(/may have taken effect/)).toHaveTextContent(
    "Refresh channels before trying again.",
  );
  expect(screen.queryByText(/Close this dialog/)).toBeNull();
  expect(
    screen.queryByRole("button", { name: /retry|leave channel/i }),
  ).toBeNull();
  expect(completed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(lifecycle.run).toHaveBeenCalledOnce();
});

it.each(
  ([{ action: "delete", label: "Delete channel" }] as const).flatMap(
    ({ action, label }) =>
      ["backdrop", "escape", "close", "cancel"].map((dismissal) => ({
        action,
        label,
        dismissal,
      })),
  ),
)(
  "$action $dismissal dismissal cancels without executing and starts on Cancel",
  async ({ action, label, dismissal }) => {
    const user = userEvent.setup();
    const lifecycle = capability();
    const close = vi.fn();
    const completed = vi.fn();
    render(
      <ChannelLifecycleDialog
        channelId="id"
        channelName="Fixture"
        action={action}
        lifecycle={lifecycle}
        close={close}
        completed={completed}
      />,
    );
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    await user.click(
      screen.getByRole("heading", {
        name: action === "delete" ? "Delete Fixture?" : `${label}: Fixture`,
      }),
    );
    expect(close).not.toHaveBeenCalled();
    if (dismissal === "backdrop")
      await user.click(
        document.querySelector(".buzz-dialog-backdrop") as Element,
      );
    else if (dismissal === "escape") await user.keyboard("{Escape}");
    else
      await user.click(
        screen.getByRole("button", {
          name: dismissal === "close" ? "Close" : "Cancel",
        }),
      );
    expect(close).toHaveBeenCalledOnce();
    expect(lifecycle.run).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
  },
);

it.each([
  ["archive", "Archive channel", "prominent", "subtle", false],
  ["unarchive", "Unarchive channel", "prominent", "subtle", true],
  ["hide", "Hide conversation", "prominent", "subtle", true],
  ["leave", "Leave channel", "subtle", "subtle", false],
  ["delete", "Delete channel", "destructive", "subtle", false],
] as const)(
  "Enter presses the focused default button for %s",
  async (action, label, confirmVariant, cancelVariant, confirms) => {
    const lifecycle = capability();
    const close = vi.fn();
    const user = userEvent.setup();
    render(
      <ChannelLifecycleDialog
        channelId="id"
        channelName="Fixture"
        action={action}
        lifecycle={lifecycle}
        close={close}
        completed={vi.fn()}
      />,
    );
    const confirm = screen.getByRole("button", { name: label });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(confirm).toHaveAttribute("data-variant", confirmVariant);
    expect(cancel).toHaveAttribute("data-variant", cancelVariant);
    await waitFor(() => expect(confirms ? confirm : cancel).toHaveFocus());
    await user.keyboard("{Enter}");
    if (confirms) {
      await waitFor(() =>
        expect(lifecycle.run).toHaveBeenCalledWith(
          action,
          "id",
          expect.any(AbortSignal),
        ),
      );
      expect(close).not.toHaveBeenCalled();
    } else {
      expect(close).toHaveBeenCalledOnce();
      expect(lifecycle.run).not.toHaveBeenCalled();
    }
  },
);

it("names Solo chats as chats in the menu and result", async () => {
  const lifecycle = capability();
  const choose = vi.fn();
  render(
    <ContextMenuRoot open>
      <MenuPopup>
        <ChannelLifecycleMenu
          channel={summary({ channelType: "solo" })}
          session={session(lifecycle)}
          choose={choose}
          disabled={false}
          separator={false}
          noun="chat"
        />
      </MenuPopup>
    </ContextMenuRoot>,
  );
  expect(
    await screen.findByRole("menuitem", { name: "Archive chat" }),
  ).toBeDefined();
  expect(screen.getByRole("menuitem", { name: "Delete chat" })).toBeDefined();
  cleanup();
  const undo = vi.fn();
  render(
    <ToastProvider>
      <ChannelLifecycleDialog
        channelId="id"
        channelName="Planning"
        noun="chat"
        action="archive"
        lifecycle={lifecycle}
        completed={() => {}}
        close={() => {}}
        undo={undo}
      />
    </ToastProvider>,
  );
  // Archiving a chat skips confirmation; its result toast offers Undo.
  expect(screen.queryByRole("dialog", { name: /^Archive chat/ })).toBeNull();
  expect(await screen.findByText("Chat archived: Planning")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(undo).toHaveBeenCalledOnce();
  cleanup();
  render(
    <ToastProvider>
      <ChannelLifecycleDialog
        channelId="id"
        channelName="Planning"
        noun="chat"
        action="unarchive"
        confirmed
        lifecycle={lifecycle}
        completed={() => {}}
        close={() => {}}
      />
    </ToastProvider>,
  );
  // Undo was already chosen: it runs without asking and reports its result.
  expect(screen.queryByRole("dialog", { name: /^Unarchive chat/ })).toBeNull();
  expect(await screen.findByText("Chat unarchived: Planning")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});

it("chat archive runs without confirmation, then Undo unarchives from its result toast", async () => {
  const lifecycle = capability();
  const gate = deferred<void>();
  lifecycle.run.mockImplementationOnce(() => gate.promise);
  const completed = vi.fn();
  const failed = vi.fn();
  function Host() {
    // Stands in for the session-owned handoff: Undo reopens its owner.
    const [action, setAction] = useState<"archive" | "unarchive">();
    const [open, setOpen] = useState(true);
    return (
      <ToastProvider>
        {open && (
          <ChannelLifecycleDialog
            key={action ?? "archive"}
            channelId="id"
            channelName="Fixture"
            noun="chat"
            action={action ?? "archive"}
            confirmed={!!action}
            lifecycle={lifecycle}
            close={() => setOpen(false)}
            completed={() => {
              completed();
              setOpen(false);
            }}
            failed={(title, message) => {
              failed(title, message);
              setOpen(false);
            }}
            undo={() => {
              setAction("unarchive");
              setOpen(true);
            }}
          />
        )}
      </ToastProvider>
    );
  }
  render(<Host />);
  expect(screen.queryByRole("button", { name: "Archive chat" })).toBeNull();
  try {
    await waitFor(() =>
      expect(lifecycle.run).toHaveBeenCalledWith(
        "archive",
        "id",
        expect.any(AbortSignal),
      ),
    );
    // A fast archive shows no progress; only a slow one is announced.
    expect(
      screen.queryByRole("dialog", { name: "Archiving chat…" }),
    ).toBeNull();
    expect(
      await screen.findByRole(
        "dialog",
        { name: "Archiving chat…" },
        { timeout: 2000 },
      ),
    ).toBeDefined();
  } finally {
    await act(async () => gate.resolve());
  }
  await screen.findByRole("dialog", { name: "Chat archived: Fixture" });
  expect(completed).toHaveBeenCalledOnce();
  lifecycle.run.mockRejectedValueOnce(new Error("Relay rejected the request."));
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() =>
    expect(lifecycle.run).toHaveBeenLastCalledWith(
      "unarchive",
      "id",
      expect.any(AbortSignal),
    ),
  );
  await waitFor(() =>
    expect(failed).toHaveBeenCalledExactlyOnceWith(
      "Unarchive chat failed",
      "Relay rejected the request.",
    ),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull(),
  );
});
