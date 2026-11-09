// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import { DraftSettings } from "./DraftSettings";

afterEach(cleanup);

async function view(canvas = "", name?: string) {
  const close = vi.fn();
  const save = vi.fn();
  render(
    <DraftSettings
      session={{} as RelaySession}
      canvas={canvas}
      name={name}
      close={close}
      save={save}
    />,
  );
  await screen.findByRole("textbox", { name: /^Instructions/ });
  return { close, save };
}
const change = (name: RegExp, value: string) =>
  fireEvent.change(screen.getByRole("textbox", { name }), {
    target: { value },
  });
const prompt = () =>
  screen.findByRole("alertdialog", { name: "Discard changes?" });

it.each([
  ["name", () => change(/^Chat name/, "Launch plan")],
  [
    "lifetime",
    () => fireEvent.click(screen.getByRole("radio", { name: /^Temporary/ })),
  ],
  ["instructions", () => change(/^Instructions/, "Keep the 4.2 scope")],
  [
    "folders",
    () => {
      change(/^Folders/, "/repo");
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    },
  ],
] as const)(
  "asks before Escape or Close drops an edited %s",
  async (_, edit) => {
    const user = userEvent.setup();
    const { close, save } = await view();
    edit();
    await user.keyboard("{Escape}");
    const asked = await prompt();
    expect(asked).toHaveAccessibleDescription(
      "Your settings have unsaved changes.",
    );
    const keep = within(asked).getByRole("button", { name: "Keep editing" });
    await waitFor(() => expect(keep).toHaveFocus());
    await user.click(keep);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(close).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(
      within(await prompt()).getByRole("button", { name: "Discard changes" }),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  },
);

it("asks before dropping an edited raw Canvas, but not for opening one", async () => {
  const user = userEvent.setup();
  const { close } = await view("<!-- buzz-session-workspace:v1 hand edited");
  const raw = screen.getByRole("textbox", { name: /^Instructions/ });
  expect(raw).toHaveAccessibleDescription(/custom workspace setup/);
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledOnce();
  fireEvent.change(raw, { target: { value: "Rewritten by hand" } });
  await user.keyboard("{Escape}");
  expect(await prompt()).toBeVisible();
  expect(close).toHaveBeenCalledOnce();
});

it("closes untouched or reverted settings at once, and Cancel discards edits without asking", async () => {
  const user = userEvent.setup();
  const { close, save } = await view();
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledTimes(1);
  change(/^Instructions/, "Keep the 4.2 scope");
  change(/^Instructions/, "");
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(close).toHaveBeenCalledTimes(2);
  change(/^Chat name/, "Launch plan");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it("closes a name changed only by formatting at once, but asks before dropping a rename", async () => {
  const user = userEvent.setup();
  const { close } = await view("", "Plan");
  change(/^Chat name/, "#Plan ");
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  change(/^Chat name/, "Launch plan");
  await user.keyboard("{Escape}");
  expect(await prompt()).toBeVisible();
  expect(close).toHaveBeenCalledOnce();
});

it("Escape in the prompt only dismisses the prompt and keeps an unadded folder path", async () => {
  const user = userEvent.setup();
  const { close } = await view();
  change(/^Chat name/, "Launch plan");
  change(/^Folders/, "/repo/not-added-yet");
  await user.keyboard("{Escape}");
  expect(await prompt()).toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.getByRole("dialog", { name: "Edit chat" })).toBeVisible();
  expect(screen.getByRole("textbox", { name: /^Folders/ })).toHaveValue(
    "/repo/not-added-yet",
  );
  expect(screen.getByRole("textbox", { name: /^Chat name/ })).toHaveValue(
    "Launch plan",
  );
  expect(close).not.toHaveBeenCalled();
});

it("closes at once while settings load and after their load fails", async () => {
  const user = userEvent.setup();
  let fail!: (reason: Error) => void;
  const refresh = vi.fn(
    () =>
      new Promise<void>((_, reject) => {
        fail = reject;
      }),
  );
  const close = vi.fn();
  render(
    <DraftSettings
      session={{ soloPreferences: { refresh } } as unknown as RelaySession}
      projectId="work"
      close={close}
      save={vi.fn()}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Loading settings…");
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledTimes(1);
  fail(new Error("Workspace defaults couldn’t load."));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Workspace defaults couldn’t load.",
  );
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});
