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
import { afterEach, expect, it, vi } from "vitest";
import { ExternalConnectionSettings } from "./ExternalConnectionSettings";
import {
  createExternalApps,
  type ExternalApps,
} from "../../features/agents/external-connection";
afterEach(cleanup);
const request = (client = "Test client", state = "A") => ({
  version: 1 as const,
  client,
  callback: "http://127.0.0.1:1234/buzz/authorize",
  state: state.repeat(43),
  scope: ["agent" as const],
  code_challenge: "A".repeat(43),
  code_challenge_method: "S256" as const,
});
type Session = { signal: AbortSignal; closed: Promise<void>; end(): void };
type Pairing = NonNullable<Parameters<ExternalApps["bind"]>[0]["pairing"]>;
/** A host that records every session's abort signal and lets a test end it. */
function host(pairing?: Pairing) {
  const sessions: Session[] = [];
  const connection = createExternalApps();
  connection.bind({
    connect: async (_key, signal) => {
      let end!: () => void;
      const closed = new Promise<void>((resolve) => {
        end = resolve;
      });
      sessions.push({ signal, closed, end });
      return {
        url: "http://127.0.0.1:1234/mcp",
        headers: [],
        closed,
        close: async () => end(),
        authorize: async () => {},
      };
    },
    deny: async () => {},
    ...(pairing ? { pairing } : {}),
  });
  return { connection, sessions };
}
/** A live session whose abort signal and close are observable. */
async function connected(pairing?: Pairing) {
  const { connection, sessions } = host(pairing);
  connection.open(request(), "viewer");
  await connection.approve("test-agent");
  const session = sessions[0] as Session;
  return {
    connection,
    sessions,
    closed: session.closed,
    end: session.end,
    aborted: () => session.signal.aborted,
  };
}
const saved = {
  id: "C".repeat(43),
  approval: {
    client: "Saved client",
    viewer: "viewer",
    agent: "test-agent",
    community: "https://example.test",
    scopes: ["agent" as const],
  },
  expires_at: 2_000_000_000,
};
/** A saved approval with no live session; `pairing` answers the native calls. */
function restorable(pairing: Pairing) {
  const connection = createExternalApps();
  connection.bind({
    connect: async () => {
      throw new Error("not used");
    },
    deny: async () => {},
    pairing,
  });
  return connection;
}
it("shows an authorized app after settings reopen and revokes it only after confirming", async () => {
  const { connection, closed, aborted } = await connected();
  const first = render(<ExternalConnectionSettings connection={connection} />);
  expect(screen.getByText("Test client")).toBeVisible();
  first.unmount();
  render(<ExternalConnectionSettings connection={connection} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Revoke access" }));
  const dialog = screen.getByRole("alertdialog", {
    name: "Revoke access for Test client?",
  });
  expect(dialog).toHaveAccessibleDescription(
    "This ends the connection now. The app must ask for access again before it can use Buzz.",
  );
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus(),
  );
  expect(aborted()).toBe(false);
  await user.click(
    within(dialog).getByRole("button", { name: "Revoke access" }),
  );
  expect(aborted()).toBe(true);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  const status = screen.getByRole("status");
  expect(status).toHaveTextContent("No external app has access.");
  await waitFor(() => expect(status).toHaveFocus());
  await act(async () => closed);
});

it("keeps access when the owner cancels or escapes the confirmation", async () => {
  const { connection, aborted } = await connected();
  render(<ExternalConnectionSettings connection={connection} />);
  const user = userEvent.setup();
  const revoke = screen.getByRole("button", { name: "Revoke access" });
  await user.click(revoke);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() => expect(revoke).toHaveFocus());
  await user.click(revoke);
  expect(screen.getByRole("alertdialog")).toBeVisible();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() => expect(revoke).toHaveFocus());
  expect(aborted()).toBe(false);
  expect(screen.getByText("Test client")).toBeVisible();
});

it("closes without revoking when a fresh approval with the same name replaces the grant", async () => {
  const { connection, sessions } = await connected();
  render(<ExternalConnectionSettings connection={connection} />);
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Revoke access" });
  await user.click(trigger);
  const dialog = screen.getByRole("alertdialog", {
    name: "Revoke access for Test client?",
  });
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus(),
  );
  const revoke = vi.spyOn(connection, "revoke");
  // The owner approves a second request in its own consent dialog meanwhile.
  // Its name is not attested, so a repeat of the same name must still count.
  await act(async () => {
    connection.open(request("Test client", "B"), "viewer");
    await connection.approve("test-agent");
  });
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(revoke).not.toHaveBeenCalled();
  expect(screen.getByText("Test client")).toBeVisible();
  expect(sessions).toHaveLength(2);
  expect((sessions[1] as Session).signal.aborted).toBe(false);
  expect(screen.getByRole("button", { name: "Revoke access" })).toBe(trigger);
  await waitFor(() => expect(trigger).toHaveFocus());
});

it("keeps the confirmation open while a revoke is in flight, even as the grant changes", async () => {
  // Holds the owner's revoke at the native call; approve()'s own calls pass.
  let release!: () => void;
  let hold = false;
  const pairing = async (operation: string) => {
    if (operation === "revoke" && hold)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return null;
  };
  const { connection, sessions } = await connected(pairing);
  render(<ExternalConnectionSettings connection={connection} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Revoke access" }));
  const dialog = screen.getByRole("alertdialog", {
    name: "Revoke access for Test client?",
  });
  hold = true;
  await user.click(
    within(dialog).getByRole("button", { name: "Revoke access" }),
  );
  hold = false;
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  expect(cancel).toBeDisabled();
  // Another app's approval replaces the grant before the native revoke
  // returns. The dialog stays, pending, until its own revoke settles.
  await act(async () => {
    connection.open(request("Other client", "B"), "viewer");
    await connection.approve("test-agent");
  });
  expect(connection.snapshot().grant?.client).toBe("Other client");
  expect(sessions).toHaveLength(2);
  expect(screen.getByRole("alertdialog")).toBe(dialog);
  expect(cancel).toBeDisabled();
  await act(async () => release());
  expect(screen.queryByRole("alertdialog")).toBeNull();
  // Focus lands on the card, not body, whatever the revoke left in the row.
  const card = screen.getByRole("region", { name: "External apps" });
  await waitFor(() => expect(card.contains(document.activeElement)).toBe(true));
});

it("returns focus to the card when the app exits before the owner cancels", async () => {
  const { connection, end } = await connected();
  render(<ExternalConnectionSettings connection={connection} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Revoke access" }));
  const dialog = screen.getByRole("alertdialog");
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  await waitFor(() => expect(cancel).toHaveFocus());
  await act(async () => end());
  // Same app, so the confirmation stays; only its trigger has gone.
  expect(screen.getByRole("alertdialog")).toBe(dialog);
  await user.click(cancel);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(
    screen.getByText(
      "Connection ended. Start setup again in the external app.",
    ),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Revoke access" })).toBeNull();
  // Named, so the landing spot announces as the External apps region.
  const card = screen.getByRole("region", { name: "External apps" });
  await waitFor(() => expect(card).toHaveFocus());
});

it("does not show an earlier, unrelated error inside the confirmation", async () => {
  const { connection, aborted } = await connected();
  // Approving with nothing pending fails without touching the grant.
  await connection.approve("test-agent");
  render(<ExternalConnectionSettings connection={connection} />);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "This request has ended. Start setup again in the external app.",
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Revoke access" }));
  const dialog = screen.getByRole("alertdialog");
  expect(within(dialog).queryByRole("alert")).toBeNull();
  expect(screen.queryAllByRole("alert", { hidden: true })).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(aborted()).toBe(false);
});

it("keeps the dialog open with the error when the saved approval cannot be removed", async () => {
  const pairing = vi.fn(async (operation: string) => {
    if (operation === "revoke") throw new Error("native revoke failed");
    return saved;
  });
  const connection = restorable(pairing);
  render(<ExternalConnectionSettings connection={connection} />);
  expect(
    await screen.findByText("Approved. The app can restore this connection."),
  ).toBeVisible();
  const user = userEvent.setup();
  const revoke = screen.getByRole("button", { name: "Revoke access" });
  await user.click(revoke);
  const dialog = screen.getByRole("alertdialog", {
    name: "Revoke access for Saved client?",
  });
  expect(dialog).toHaveAccessibleDescription(
    "This removes the saved approval. The app must ask for access again before it can use Buzz.",
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Revoke access" }),
  );
  const alert = await within(dialog).findByRole("alert");
  expect(alert).toHaveTextContent(
    "Could not remove the saved approval. Try again.",
  );
  // The modal hides the page from role queries; count hidden alerts too.
  expect(screen.getAllByRole("alert", { hidden: true })).toHaveLength(1);
  expect(pairing).toHaveBeenCalledWith("revoke");
  expect(screen.getByText("Saved client")).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not remove the saved approval. Try again.",
  );
  expect(screen.getByRole("button", { name: "Revoke access" })).toBe(revoke);
  await waitFor(() => expect(revoke).toHaveFocus());
});

it("announces a repeated failure again and leaves no alert once a retry succeeds", async () => {
  let refusals = 2;
  const connection = restorable(async (operation) => {
    if (operation === "revoke" && refusals-- > 0)
      throw new Error("native revoke failed");
    return saved;
  });
  render(<ExternalConnectionSettings connection={connection} />);
  expect(
    await screen.findByText("Approved. The app can restore this connection."),
  ).toBeVisible();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Revoke access" }));
  const dialog = screen.getByRole("alertdialog");
  const confirm = within(dialog).getByRole("button", { name: "Revoke access" });
  await user.click(confirm);
  const first = await within(dialog).findByRole("alert");
  await user.click(confirm);
  // A fresh alert element, so assistive tech reads the second failure too.
  const second = await within(dialog).findByRole("alert");
  expect(second).not.toBe(first);
  expect(second).toHaveTextContent(
    "Could not remove the saved approval. Try again.",
  );
  await user.click(confirm);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  const status = screen.getByRole("status");
  expect(status).toHaveTextContent("No external app has access.");
  await waitFor(() => expect(status).toHaveFocus());
});

it("asks for new setup when a saved approval has only older, limited access", async () => {
  const connection = restorable(async () => ({
    ...saved,
    approval: {
      ...saved.approval,
      client: "Old client",
      scopes: ["read", "post"],
    },
  }));
  render(<ExternalConnectionSettings connection={connection} />);
  expect(
    await screen.findByText(/older approval gives limited access/),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Revoke access" })).toBeVisible();
});
