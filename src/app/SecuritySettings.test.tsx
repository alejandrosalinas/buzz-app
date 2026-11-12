// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SecuritySettings } from "./SecuritySettings";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
  Channel: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const tool = {
  id: "p1",
  client: "buzz-cli",
  relay: "wss://relay.example/",
  created: 1_800_000_000,
  lastUsed: 1_800_000_000,
  expires: 1_802_592_000,
};
const other = { ...tool, id: "p2", client: "notes", relay: "wss://other/" };
const third = { ...tool, id: "p3", client: "deploy", relay: "wss://third/" };
const revoked = ["credential_pairing_revoke", expect.anything()] as const;
/** Settings passes a viewer whenever there is a native identity, mounting
 * Authorize external identity below the list; its key field is then the
 * section's first tabbable control once no row remains. */
const viewers = [
  { shown: "without a viewer", viewer: undefined },
  { shown: "with a viewer", viewer: "ab".repeat(32) },
];
beforeEach(() => {
  vi.mocked(listen).mockResolvedValue(() => {});
});
afterEach(cleanup);

/** Clicks a row's Revoke and returns the confirmation it opens. */
async function ask(revoke: HTMLElement | undefined, client: string) {
  if (!revoke) throw new Error("No Revoke button");
  // Only this click is judged; an earlier confirmed revoke may have run.
  vi.mocked(invoke).mockClear();
  await userEvent.click(revoke);
  expect(invoke).not.toHaveBeenCalledWith(...revoked);
  const dialog = screen.getByRole("alertdialog", { name: `Revoke ${client}?` });
  expect(dialog).toHaveTextContent(
    "It stops working until you pair it again with buzz auth desktop pair.",
  );
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus(),
  );
  return dialog;
}

/** Fires the section's `credential-pairings-changed` listener, as native
 * does after any saved pairing mutation, and waits for the refresh. */
function changedListener() {
  const changed = vi
    .mocked(listen)
    .mock.calls.filter(([event]) => event === "credential-pairings-changed")
    .at(-1)?.[1];
  if (!changed) throw new Error("Not listening for changes");
  return () =>
    act(async () => {
      changed({ event: "credential-pairings-changed", id: 1, payload: null });
    });
}

/** Focus is on the paired-tools heading: not body, and not the Authorize
 * form's key field when a viewer shows one. */
async function landedOnHeading(viewer: string | undefined) {
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Paired command-line tools" }),
    ).toHaveFocus(),
  );
  const key = screen.queryByLabelText("Application public key (hex)");
  if (viewer) expect(key).toBeInTheDocument();
  else expect(key).toBeNull();
}

it("lists paired tools and revokes one after asking", async () => {
  let release = () => {};
  vi.mocked(invoke).mockImplementation((command) =>
    command === "credential_pairings_list"
      ? Promise.resolve([tool, other])
      : new Promise<void>((resolve) => {
          release = resolve;
        }),
  );
  render(<SecuritySettings />);
  expect(await screen.findByText("buzz-cli")).toBeInTheDocument();
  expect(
    screen.getByText(/wss:\/\/relay\.example\/ · Paired/),
  ).toBeInTheDocument();
  const [first] = screen.getAllByRole("button", { name: "Revoke" });
  const dialog = await ask(first, "buzz-cli");
  const confirm = within(dialog).getByRole("button", { name: "Revoke" });
  await userEvent.click(confirm);
  expect(invoke).toHaveBeenCalledWith("credential_pairing_revoke", {
    id: "p1",
  });
  // The dialog holds while native works, with Revoke busy and Cancel disabled.
  expect(confirm).toHaveAttribute("aria-busy", "true");
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  release();
  await waitFor(() => expect(screen.queryByText("buzz-cli")).toBeNull());
  expect(screen.queryByRole("alertdialog")).toBeNull();
  // Focus moves to the next row's Revoke, not body.
  const next = screen.getByRole("button", { name: "Revoke" });
  await waitFor(() => expect(next).toHaveFocus());
});

it.each(viewers)(
  "revoking the last tool leaves focus on the paired-tools heading, $shown",
  async ({ viewer }) => {
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "credential_pairings_list" ? [tool] : undefined,
    );
    render(<SecuritySettings viewer={viewer} />);
    const revoke = await screen.findByRole("button", { name: "Revoke" });
    await userEvent.click(
      within(await ask(revoke, "buzz-cli")).getByRole("button", {
        name: "Revoke",
      }),
    );
    expect(invoke).toHaveBeenCalledWith("credential_pairing_revoke", {
      id: "p1",
    });
    expect(await screen.findByText("No paired tools")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await landedOnHeading(viewer);
  },
);

it("revoking the last-listed tool moves focus to the row just before it", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "credential_pairings_list" ? [tool, other, third] : undefined,
  );
  render(<SecuritySettings />);
  expect(await screen.findByText("deploy")).toBeInTheDocument();
  const [first, second, last] = screen.getAllByRole("button", {
    name: "Revoke",
  });
  // No row follows the third, so focus goes to the second: the immediately
  // previous row, not the top one.
  await userEvent.click(
    within(await ask(last, "deploy")).getByRole("button", { name: "Revoke" }),
  );
  expect(invoke).toHaveBeenCalledWith("credential_pairing_revoke", {
    id: "p3",
  });
  await waitFor(() => expect(screen.queryByText("deploy")).toBeNull());
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() => expect(second).toHaveFocus());
  // Then the second of two: focus goes to the first row's Revoke, not body.
  await userEvent.click(
    within(await ask(second, "notes")).getByRole("button", { name: "Revoke" }),
  );
  expect(invoke).toHaveBeenCalledWith("credential_pairing_revoke", {
    id: "p2",
  });
  await waitFor(() => expect(screen.queryByText("notes")).toBeNull());
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByText("buzz-cli")).toBeInTheDocument();
  await waitFor(() => expect(first).toHaveFocus());
});

it("cancels without revoking and returns focus to the row's Revoke", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "credential_pairings_list" ? [tool] : undefined,
  );
  render(<SecuritySettings />);
  const revoke = await screen.findByRole("button", { name: "Revoke" });
  await userEvent.click(
    within(await ask(revoke, "buzz-cli")).getByRole("button", {
      name: "Cancel",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(revoke).toHaveFocus());
  await ask(revoke, "buzz-cli");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(revoke).toHaveFocus());
  expect(invoke).not.toHaveBeenCalledWith(...revoked);
  expect(screen.getByText("buzz-cli")).toBeInTheDocument();
});

it("keeps the row and the open dialog, and says why, when revoking fails", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "credential_pairings_list") return [tool];
    throw "Paired tools could not be saved to secure storage";
  });
  render(<SecuritySettings />);
  const revoke = await screen.findByRole("button", { name: "Revoke" });
  const dialog = await ask(revoke, "buzz-cli");
  await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "could not be saved",
  );
  // One alert, inside the dialog; the row stays.
  expect(screen.getAllByRole("alert", { hidden: true })).toHaveLength(1);
  expect(dialog).toBeInTheDocument();
  expect(screen.getByText("buzz-cli")).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  // The failure belonged to that confirmation; the list has nothing to say.
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("buzz-cli")).toBeInTheDocument();
  await waitFor(() => expect(revoke).toHaveFocus());
  // Asking again starts clean.
  expect(within(await ask(revoke, "buzz-cli")).queryByRole("alert")).toBeNull();
});

it("keeps a failed revoke's message through a list refresh while the dialog is open", async () => {
  let listed: Promise<(typeof tool)[]> = Promise.resolve([tool]);
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "credential_pairings_list") return listed;
    return Promise.reject("Paired tools could not be saved to secure storage");
  });
  render(<SecuritySettings />);
  const revoke = await screen.findByRole("button", { name: "Revoke" });
  const refresh = changedListener();
  const dialog = await ask(revoke, "buzz-cli");
  await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
  const failure = await within(dialog).findByRole("alert");
  expect(failure).toHaveTextContent("could not be saved");
  // Another saved mutation refreshes the list successfully: the dialog is
  // still open, so its failure message stays.
  await refresh();
  expect(dialog).toBeInTheDocument();
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "could not be saved",
  );
  expect(screen.getAllByRole("alert", { hidden: true })).toHaveLength(1);
  // A refresh that fails does not replace it either; the read error belongs
  // to the list, behind the dialog.
  listed = Promise.reject("Paired tools could not be read from secure storage");
  await refresh();
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "could not be saved",
  );
  expect(within(dialog).queryByText(/could not be read/)).toBeNull();
  await waitFor(() =>
    expect(
      screen.getAllByRole("alert", { hidden: true }).map((a) => a.textContent),
    ).toEqual([
      "Paired tools could not be read from secure storage",
      "Paired tools could not be saved to secure storage",
    ]),
  );
  // Retrying clears the old message while the revoke runs.
  let release = () => {};
  vi.mocked(invoke).mockImplementation((command) =>
    command === "credential_pairings_list"
      ? listed
      : new Promise<void>((resolve) => {
          release = resolve;
        }),
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
  expect(within(dialog).queryByRole("alert")).toBeNull();
  release();
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  // Closed, the list's own read error is what remains.
  expect(screen.getByRole("alert")).toHaveTextContent("could not be read");
});

it("does not show a list read failure inside an open revoke dialog", async () => {
  let listed: Promise<(typeof tool)[]> = Promise.resolve([tool]);
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "credential_pairings_list" ? listed : undefined,
  );
  render(<SecuritySettings />);
  const revoke = await screen.findByRole("button", { name: "Revoke" });
  const refresh = changedListener();
  const dialog = await ask(revoke, "buzz-cli");
  listed = Promise.reject("Paired tools could not be read from secure storage");
  await refresh();
  await waitFor(() => expect(screen.queryByText("buzz-cli")).toBeNull());
  expect(dialog).toBeInTheDocument();
  expect(within(dialog).queryByRole("alert")).toBeNull();
  // The read error is on the list, behind the modal.
  const alerts = screen.getAllByRole("alert", { hidden: true });
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toHaveTextContent("could not be read");
  expect(dialog).not.toContainElement(alerts[0] ?? null);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.getByRole("alert")).toHaveTextContent("could not be read");
  expect(invoke).not.toHaveBeenCalledWith(...revoked);
});

it.each(viewers)(
  "keeps focus on the paired-tools heading when a refresh drops the row while its dialog is open, $shown",
  async ({ viewer }) => {
    let listed = [tool];
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "credential_pairings_list" ? listed : undefined,
    );
    render(<SecuritySettings viewer={viewer} />);
    const revoke = await screen.findByRole("button", { name: "Revoke" });
    const changed = changedListener();
    const refresh = (tools: (typeof tool)[]) => {
      listed = tools;
      return changed();
    };
    // Revoked elsewhere while the dialog is open, then Escape: the heading,
    // not body and not the Authorize form's key field.
    await ask(revoke, "buzz-cli");
    await refresh([]);
    await waitFor(() => expect(screen.queryByText("buzz-cli")).toBeNull());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await landedOnHeading(viewer);
    expect(invoke).not.toHaveBeenCalledWith(...revoked);
    // The same, but confirming: the row is gone, so the heading again.
    await refresh([tool]);
    const dialog = await ask(
      await screen.findByRole("button", { name: "Revoke" }),
      "buzz-cli",
    );
    await refresh([]);
    await waitFor(() => expect(screen.queryByText("buzz-cli")).toBeNull());
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Revoke" }),
    );
    expect(invoke).toHaveBeenCalledWith("credential_pairing_revoke", {
      id: "p1",
    });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await landedOnHeading(viewer);
  },
);

it("shows an empty state, and a read failure", async () => {
  vi.mocked(invoke).mockResolvedValueOnce([]);
  render(<SecuritySettings />);
  expect(await screen.findByText("No paired tools")).toBeInTheDocument();
  expect(screen.queryByText("Authorize external identity")).toBeNull();
  cleanup();
  vi.mocked(invoke).mockRejectedValueOnce(
    "Paired tools could not be read from secure storage",
  );
  render(<SecuritySettings />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "could not be read",
  );
});
