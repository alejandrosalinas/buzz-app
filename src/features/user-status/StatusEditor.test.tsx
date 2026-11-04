// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import type { UserStatus } from "../relay/user-status";
import { StatusEditor } from "./StatusEditor";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setup(current?: UserStatus) {
  const owner = createRelaySession(null);
  owners.push(owner);
  const save = vi.fn(async () => {});
  const close = vi.fn();
  const session = {
    ...owner.session,
    statuses: { ...owner.session.statuses, save },
  };
  render(
    <StatusEditor
      session={session}
      scope="https://status.test"
      current={current}
      close={close}
      finalFocus={{ current: null }}
    />,
  );
  return { save, close };
}
it("calculates the selected preset at save time after a quick choice is edited", async () => {
  const user = userEvent.setup();
  let now = 1_700_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { save, close } = setup();
  await user.click(screen.getByRole("button", { name: "In a meeting" }));
  fireEvent.change(screen.getByLabelText("Status message"), {
    target: { value: "Design review" },
  });
  await user.click(screen.getByRole("button", { name: "Duration: Today" }));
  expect(
    screen.queryByRole("menuitemradio", { name: "Don’t clear" }),
  ).not.toBeInTheDocument();
  await user.click(
    await screen.findByRole("menuitemradio", { name: "8 hours" }),
  );
  now += 600_000;
  await user.click(screen.getByRole("button", { name: "Save status" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledWith({
    text: "Design review",
    emoji: "🗣️",
    expiresAt: now / 1000 + 28800,
  });
});
it("prefills and preserves an existing deadline, and validates a custom date before saving", async () => {
  // Mid-month so the prefilled next-day deadline opens the calendar on today's month.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 5, 15, 12) });
  const user = userEvent.setup();
  const now = Date.now();
  const expiresAt = Math.floor(now / 1000) + 86400;
  const { save } = setup({
    userId: "a".repeat(64),
    text: "Remote",
    emoji: "🏠",
    updatedAt: now / 1000,
    expiresAt,
  });
  expect(screen.getByLabelText("Status message")).toHaveValue("Remote");
  await user.click(screen.getByRole("button", { name: "Save status" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      text: "Remote",
      emoji: "🏠",
      expiresAt,
    }),
  );
  await user.click(screen.getByRole("button", { name: /^Duration:/ }));
  await user.click(
    await screen.findByRole("menuitemradio", {
      name: "Custom",
    }),
  );
  await user.click(
    screen.getByRole("button", { name: "Status expiration time" }),
  );
  const options = await screen.findAllByRole("menuitemradio");
  expect(options).toHaveLength(48);
  expect(options[0]).toHaveTextContent("12:00 AM");
  expect(options[47]).toHaveTextContent("11:30 PM");
  await user.click(screen.getByRole("menuitemradio", { name: "12:00 AM" }));
  await user.click(
    screen.getByRole("button", { name: "Status expiration date" }),
  );
  await user.click(await screen.findByRole("button", { name: /^Today,/ }));
  await user.click(screen.getByRole("button", { name: "Save status" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Choose a date and time in the future.",
  );
  expect(save).toHaveBeenCalledOnce();
  await user.click(
    screen.getByRole("button", { name: "Status expiration date" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Today,/ })).toHaveFocus(),
  );
  await user.keyboard("{ArrowRight}{Enter}");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Status expiration date" }),
    ).toHaveFocus(),
  );
  expect(
    screen.getByRole("button", { name: "Status expiration time" }),
  ).toHaveTextContent("12:00 AM");
  await user.click(
    screen.getByRole("button", { name: "Status expiration time" }),
  );
  await user.click(
    await screen.findByRole("menuitemradio", { name: "11:30 PM" }),
  );
  await user.click(screen.getByRole("button", { name: "Save status" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(23, 30, 0, 0);
  expect(save).toHaveBeenLastCalledWith({
    text: "Remote",
    emoji: "🏠",
    expiresAt: tomorrow.getTime() / 1000,
  });
});

it("adds and saves a message emoji for nonblank text, and removes the automatic emoji when emptied", async () => {
  const user = userEvent.setup();
  const { save } = setup();
  const input = screen.getByLabelText("Status message");
  const emoji = screen.getByRole("button", { name: "Choose a status emoji" });
  const submit = screen.getByRole("button", { name: "Save status" });
  await user.type(input, "Reading");
  expect(emoji).toHaveTextContent("💬");
  await user.clear(input);
  await user.type(input, "   ");
  expect(emoji).not.toHaveTextContent("💬");
  expect(submit).toBeDisabled();
  await user.clear(input);
  await user.type(input, "Reading");
  await user.click(submit);
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Reading", emoji: "💬" }),
    ),
  );
});
it.each(["🏠", ":party:"])(
  "preserves the selected %s emoji when text changes or is erased",
  async (emoji) => {
    const user = userEvent.setup();
    const { save } = setup({
      userId: "a".repeat(64),
      text: "Remote",
      emoji,
      updatedAt: Date.now() / 1000,
    });
    const input = screen.getByLabelText("Status message");
    await user.clear(input);
    await user.type(input, "Later");
    await user.click(screen.getByRole("button", { name: "Save status" }));
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "Later", emoji }),
      ),
    );
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Save status" }));
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "", emoji }),
      ),
    );
  },
);

it("names the custom code an unresolved emoji trigger will save", async () => {
  setup({
    userId: "a".repeat(64),
    text: "Remote",
    emoji: ":bee-intensifies:",
    updatedAt: Date.now() / 1000,
  });
  const trigger = screen.getByRole("button", { name: "Choose a status emoji" });
  act(() => trigger.focus());
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    ":bee-intensifies:",
  );
  expect(trigger).toHaveAccessibleDescription(":bee-intensifies:");
});

it("keeps the focused emoji trigger and renames its hint when a refresh replaces its custom code", async () => {
  const owner = createRelaySession(null);
  owners.push(owner);
  const cached: UserStatus = {
    userId: "a".repeat(64),
    text: "Remote",
    emoji: ":bee:",
    updatedAt: 1,
  };
  let resolve!: (value: UserStatus) => void;
  const current = () =>
    new Promise<UserStatus>((done) => {
      resolve = done;
    });
  render(
    <StatusEditor
      session={{
        ...owner.session,
        statuses: { ...owner.session.statuses, current },
      }}
      viewer={cached.userId}
      scope="https://status.test"
      current={cached}
      close={() => {}}
      finalFocus={{ current: null }}
    />,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Status message")).toHaveFocus(),
  );
  const trigger = screen.getByRole("button", { name: "Choose a status emoji" });
  act(() => trigger.focus());
  expect(await screen.findByRole("tooltip")).toHaveTextContent(":bee:");
  await act(async () => resolve({ ...cached, emoji: "🏠", updatedAt: 2 }));
  expect(screen.getByRole("button", { name: "Choose a status emoji" })).toBe(
    trigger,
  );
  expect(trigger).toHaveFocus();
  await waitFor(() =>
    expect(screen.getByRole("tooltip")).toHaveTextContent(/^:house:$/),
  );
  expect(trigger).toHaveAccessibleDescription(":house:");
});

it("shows non-expiring status honestly and preserves it until a duration is selected", async () => {
  const user = userEvent.setup();
  const { save } = setup({
    userId: "a".repeat(64),
    text: "Remote",
    emoji: "🏠",
    updatedAt: Date.now() / 1000,
  });
  expect(
    screen.getByRole("button", { name: "Duration: Don’t clear" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Status expiration date" }),
  ).not.toBeInTheDocument();
  await user.type(screen.getByLabelText("Status message"), " today");
  await user.click(screen.getByRole("button", { name: "Save status" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({ text: "Remote today", emoji: "🏠" }),
  );
  await user.click(screen.getByRole("button", { name: /^Duration:/ }));
  await user.click(
    await screen.findByRole("menuitemradio", { name: "1 hour" }),
  );
  await user.click(screen.getByRole("button", { name: "Save status" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({ expiresAt: expect.any(Number) }),
  );
});

it("renews the displayed preset when its original deadline passed while editing", async () => {
  const user = userEvent.setup();
  let now = 1700000000000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { save } = setup({
    userId: "a".repeat(64),
    text: "Working",
    emoji: "🏠",
    updatedAt: now / 1000,
    expiresAt: now / 1000 + 3600,
  });
  expect(
    screen.getByRole("button", { name: "Duration: 1 hour" }),
  ).toBeVisible();
  now += 3601000;
  await user.click(screen.getByRole("button", { name: "Save status" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      text: "Working",
      emoji: "🏠",
      expiresAt: now / 1000 + 3600,
    }),
  );
});

it.each([
  "none",
  "text",
  "duration",
  "custom expiration",
  "quick status",
  "emoji",
] as const)(
  "refreshes the cached draft without overwriting %s edits",
  async (edit) => {
    const user = userEvent.setup();
    const owner = createRelaySession(null);
    owners.push(owner);
    const viewer = "a".repeat(64);
    const custom = new Date();
    custom.setDate(custom.getDate() + 2);
    custom.setHours(12, 0, 0, 0);
    const cached: UserStatus | undefined =
      edit === "quick status"
        ? undefined
        : {
            userId: viewer,
            text: "Cached",
            emoji: "🏠",
            updatedAt: 1,
            ...(edit === "custom expiration"
              ? { expiresAt: custom.getTime() / 1000 }
              : {}),
          };
    let resolve!: (value: UserStatus) => void;
    const current = vi.fn(
      () =>
        new Promise<UserStatus>((done) => {
          resolve = done;
        }),
    );
    const save = vi.fn(async () => {});
    render(
      <StatusEditor
        session={{
          ...owner.session,
          statuses: { ...owner.session.statuses, current, save },
        }}
        viewer={viewer}
        scope="https://status.test"
        current={cached}
        close={() => {}}
        finalFocus={{ current: null }}
      />,
    );
    const fresh: UserStatus = {
      userId: viewer,
      text: "Fresh",
      emoji: "🚌",
      updatedAt: Date.now() / 1000,
    };
    try {
      expect(
        screen.getByRole("dialog", { name: "Set a status" }),
      ).toBeVisible();
      expect(current).toHaveBeenCalledOnce();
      if (edit === "text")
        fireEvent.change(screen.getByLabelText("Status message"), {
          target: { value: "My draft" },
        });
      if (edit === "duration") {
        await user.click(screen.getByRole("button", { name: /^Duration:/ }));
        await user.click(
          await screen.findByRole("menuitemradio", { name: "8 hours" }),
        );
      }
      if (edit === "custom expiration") {
        await user.click(
          screen.getByRole("button", { name: "Status expiration time" }),
        );
        await user.click(
          await screen.findByRole("menuitemradio", { name: "11:30 PM" }),
        );
      }
      if (edit === "quick status")
        await user.click(screen.getByRole("button", { name: "In a meeting" }));
      if (edit === "emoji") {
        for (const name of ["ResizeObserver", "IntersectionObserver"])
          vi.stubGlobal(
            name,
            class {
              observe() {}
              unobserve() {}
              disconnect() {}
            },
          );
        vi.spyOn(
          document.documentElement,
          "clientWidth",
          "get",
        ).mockReturnValue(1024);
        await user.click(
          screen.getByRole("button", { name: "Choose a status emoji" }),
        );
        const choice = await waitFor(() => {
          const button = document
            .querySelector("em-emoji-picker")
            ?.shadowRoot?.querySelector<HTMLButtonElement>(
              'button[title="Grinning Face"]',
            );
          if (!button) throw new Error("Emoji choice has not rendered");
          return button;
        });
        fireEvent.click(choice);
      }
      await act(async () => resolve(fresh));
      expect(screen.getByLabelText("Status message")).toHaveValue(
        edit === "none"
          ? "Fresh"
          : edit === "text"
            ? "My draft"
            : edit === "quick status"
              ? "In a meeting"
              : "Cached",
      );
      if (edit === "duration")
        expect(
          screen.getByRole("button", { name: "Duration: 8 hours" }),
        ).toBeVisible();
      if (edit === "custom expiration") {
        expect(
          screen.getByRole("button", { name: "Status expiration time" }),
        ).toHaveTextContent("11:30 PM");
        custom.setHours(23, 30, 0, 0);
        await user.click(screen.getByRole("button", { name: "Save status" }));
        expect(save).toHaveBeenCalledWith(
          expect.objectContaining({ expiresAt: custom.getTime() / 1000 }),
        );
      }
      if (edit === "emoji")
        expect(
          screen.getByRole("button", { name: "Choose a status emoji" }),
        ).toHaveTextContent("😀");
    } finally {
      await act(async () => resolve(fresh));
    }
  },
);

it("delays refresh feedback, surfaces failure and retries an untouched draft", async () => {
  const owner = createRelaySession(null);
  owners.push(owner);
  let reject!: (error: Error) => void;
  let resolve!: (value: undefined) => void;
  const current = vi.fn(
    () =>
      new Promise<undefined>((done, fail) => {
        resolve = done;
        reject = fail;
      }),
  );
  vi.useFakeTimers();
  render(
    <StatusEditor
      session={{
        ...owner.session,
        statuses: { ...owner.session.statuses, current },
      }}
      viewer={"a".repeat(64)}
      scope="https://status.test"
      current={undefined}
      close={() => {}}
      finalFocus={{ current: null }}
    />,
  );
  try {
    expect(screen.getByRole("button", { name: "Save status" })).toBeDisabled();
    await act(async () => vi.advanceTimersByTime(999));
    expect(
      screen.queryByText("Checking your current status…"),
    ).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(1));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking your current status…",
    );
    await act(async () => reject(new Error("Offline")));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn’t check your latest status",
    );
    const retry = screen.getByRole("button", { name: "Retry" });
    act(() => retry.focus());
    fireEvent.click(retry);
    expect(screen.getByLabelText("Status message")).toHaveFocus();
    expect(current).toHaveBeenCalledTimes(2);
    await act(async () => resolve(undefined));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Status message")).toHaveValue("");
  } finally {
    await act(async () => resolve(undefined));
    vi.useRealTimers();
  }
});

it("ignores a late refresh after a failed save and keeps the submitted draft", async () => {
  const owner = createRelaySession(null);
  owners.push(owner);
  const cached: UserStatus = {
    userId: "a".repeat(64),
    text: "Cached",
    emoji: "🏠",
    updatedAt: 1,
  };
  let resolve!: (value: UserStatus) => void;
  const current = () =>
    new Promise<UserStatus>((done) => {
      resolve = done;
    });
  const save = vi.fn(async () => {
    throw new Error("Save failed");
  });
  render(
    <StatusEditor
      session={{
        ...owner.session,
        statuses: { ...owner.session.statuses, current, save },
      }}
      viewer={cached.userId}
      scope="https://status.test"
      current={cached}
      close={() => {}}
      finalFocus={{ current: null }}
    />,
  );
  try {
    fireEvent.click(screen.getByRole("button", { name: "Save status" }));
    await screen.findByText("Save failed");
    await act(async () => resolve({ ...cached, text: "Late" }));
    expect(screen.getByLabelText("Status message")).toHaveValue("Cached");
    expect(screen.getByRole("button", { name: "Save status" })).toBeEnabled();
  } finally {
    await act(async () => resolve(cached));
  }
});

it.each(["pending", "checking", "failed"] as const)(
  "hides irrelevant refresh feedback after editing while %s",
  async (phase) => {
    const owner = createRelaySession(null);
    owners.push(owner);
    let reject!: (error: Error) => void;
    const current = vi.fn(
      () =>
        new Promise<undefined>((_resolve, fail) => {
          reject = fail;
        }),
    );
    vi.useFakeTimers();
    render(
      <StatusEditor
        session={{
          ...owner.session,
          statuses: { ...owner.session.statuses, current },
        }}
        viewer={"a".repeat(64)}
        scope="https://status.test"
        current={undefined}
        close={() => {}}
        finalFocus={{ current: null }}
      />,
    );
    try {
      expect(current).toHaveBeenCalledOnce();
      if (phase !== "pending") {
        await act(async () => vi.advanceTimersByTime(1000));
        expect(screen.getByRole("status")).toHaveTextContent(
          "Checking your current status…",
        );
      }
      if (phase === "failed") {
        await act(async () => reject(new Error("Offline")));
        expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
      }
      fireEvent.change(screen.getByLabelText("Status message"), {
        target: { value: "My draft" },
      });
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Retry" }),
      ).not.toBeInTheDocument();
      await act(async () => vi.advanceTimersByTime(1000));
      await act(async () => reject(new Error("Offline")));
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Retry" }),
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText("Status message")).toHaveValue("My draft");
      expect(screen.getByRole("button", { name: "Save status" })).toBeEnabled();
    } finally {
      await act(async () => reject(new Error("Test finished")));
      cleanup();
      vi.useRealTimers();
    }
  },
);
