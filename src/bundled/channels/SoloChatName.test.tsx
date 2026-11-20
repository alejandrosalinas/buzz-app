// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type {
  ChannelDetailsCapability,
  DetailsAttempt,
} from "../../features/relay/channel-details";
import { SoloChatName } from "./SoloChatName";

afterEach(cleanup);

function setup(overrides: Partial<ChannelDetailsCapability> = {}) {
  const save = vi.fn(async () => {});
  const close = vi.fn();
  const channels = { subscribeList: () => () => {} };
  const details: ChannelDetailsCapability = {
    available: true,
    load: vi.fn(async () => ({
      channelId: "chat",
      name: "Plan",
      description: "Keep this",
      visibility: "private" as const,
      labels: ["buzz.solo"],
      ttlSeconds: 600,
      version: "one",
      canEdit: true,
    })),
    save,
    check: vi.fn(async () => {}),
    snapshot: () => undefined,
    subscribe: () => () => {},
    ...overrides,
  };
  render(
    <>
      <SoloChatName
        session={
          { channels, channelDetails: details } as unknown as RelaySession
        }
        id="chat"
        title="Plan"
        close={close}
      />
      <button type="button">Elsewhere</button>
    </>,
  );
  return { save, close, details, channels, user: userEvent.setup() };
}

it.each(["", "Plan"])(
  "keeps the confirmed title without writing for %j",
  async (value) => {
    const f = setup();
    const input = await screen.findByRole("textbox", { name: "Chat name" });
    await waitFor(() => expect(input).toHaveFocus());
    await f.user.clear(input);
    if (value) await f.user.keyboard(value);
    await f.user.keyboard("{Enter}");
    await waitFor(() => expect(f.close).toHaveBeenCalledWith(true));
    expect(f.save).not.toHaveBeenCalled();
  },
);

it("saves on click-away without taking focus back from the destination", async () => {
  const f = setup();
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Chat name" })).toHaveFocus(),
  );
  await f.user.keyboard("Renamed");
  await f.user.click(screen.getByRole("button", { name: "Elsewhere" }));
  await waitFor(() => expect(f.close).toHaveBeenCalledWith(false));
  expect(f.save).toHaveBeenCalledWith(
    expect.objectContaining({ name: "Plan" }),
    expect.objectContaining({
      name: "Renamed",
      ttlSeconds: 600,
      description: "Keep this",
      labels: ["buzz.solo"],
    }),
    expect.any(AbortSignal),
    undefined,
    f.channels,
  );
  expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
});

it("retains an oversized draft without writing on Enter or blur", async () => {
  const f = setup();
  const input = screen.getByRole("textbox", { name: "Chat name" });
  await waitFor(() => expect(input).toHaveFocus());
  await f.user.paste("a".repeat(121));
  await f.user.keyboard("{Enter}");
  expect(screen.getByRole("alert")).toHaveTextContent("at most 120");
  await f.user.click(screen.getByRole("button", { name: "Elsewhere" }));
  expect(f.save).not.toHaveBeenCalled();
  expect(f.close).not.toHaveBeenCalled();
});

it("checks an uncertain save without republishing", async () => {
  const attempt = {
    status: "unconfirmed" as const,
    draft: {
      name: "Pending name",
      description: "Keep this",
      visibility: "private" as const,
      labels: ["buzz.solo"],
      ttlSeconds: 600,
    },
  };
  const f = setup({
    snapshot: () => attempt,
  });
  const input = screen.getByRole("textbox", { name: "Chat name" });
  await waitFor(() => expect(input).toHaveValue("Pending name"));
  expect(input).toHaveAttribute("readonly");
  await f.user.click(screen.getByRole("button", { name: "Check save status" }));
  await waitFor(() => expect(f.close).toHaveBeenCalledWith(true));
  expect(f.details.check).toHaveBeenCalledWith("chat", expect.any(AbortSignal));
  expect(f.save).not.toHaveBeenCalled();
});

it("quietly disables the name while a real pending receipt is saving", async () => {
  let pending: DetailsAttempt | undefined;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const save: ChannelDetailsCapability["save"] = vi.fn(async (_base, draft) => {
    pending = { status: "saving", draft };
    emit();
    await gate;
    pending = undefined;
    emit();
  });
  const f = setup({
    save,
    snapshot: () => pending,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  const input = screen.getByRole("textbox", { name: "Chat name" });
  await waitFor(() => expect(input).toHaveFocus());
  await f.user.keyboard("New name{Enter}");
  try {
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(input).toHaveAttribute("readonly");
    expect(input).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("form", { name: "Rename Plan" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.queryByText("Saving name…")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Reload chat details" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Check save status" }),
    ).toBeNull();
  } finally {
    await act(async () => {
      finish();
      await gate;
    });
  }
  await waitFor(() => expect(f.close).toHaveBeenCalledWith(true));
});

it("releases an abandoned initial read without restoring focus when it completes", async () => {
  let release!: (
    value: Awaited<ReturnType<ChannelDetailsCapability["load"]>>,
  ) => void;
  const loaded = new Promise<
    Awaited<ReturnType<ChannelDetailsCapability["load"]>>
  >((resolve) => {
    release = resolve;
  });
  const f = setup({ load: vi.fn(() => loaded) });
  await f.user.click(screen.getByRole("button", { name: "Elsewhere" }));
  expect(f.close).toHaveBeenCalledWith(false);
  await act(async () => {
    release({
      channelId: "chat",
      name: "Plan",
      description: "Keep this",
      visibility: "private",
      labels: ["buzz.solo"],
      version: "one",
      canEdit: true,
    });
    await loaded;
  });
  expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
  expect(f.save).not.toHaveBeenCalled();
});

it.each(["ineligible", "unrelated attempt"])(
  "releases a blocked %s editor on blur without writing",
  async (reason) => {
    const attempt = {
      status: "saving" as const,
      draft: {
        name: "Other",
        description: "Changed elsewhere",
        visibility: "private" as const,
        labels: ["buzz.solo"],
      },
    };
    const f = setup({
      ...(reason === "ineligible"
        ? {
            load: vi.fn(async () => ({
              channelId: "chat",
              name: "Plan",
              description: "",
              visibility: "private" as const,
              labels: ["stream"],
              version: "one",
              canEdit: false,
            })),
          }
        : { snapshot: () => attempt }),
    });
    await screen.findByText(
      reason === "ineligible"
        ? "This chat can’t be renamed."
        : "Finish the pending change in Chat settings first.",
    );
    await f.user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(f.close).toHaveBeenCalledWith(false);
    expect(f.save).not.toHaveBeenCalled();
  },
);
