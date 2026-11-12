// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { WelcomeBack } from "./WelcomeBack";
afterEach(cleanup);
it.each([true, false])(
  "names a key that isn't on this device and selects it through the available recovery route (backup: %s)",
  (backup) => {
    const restore = vi.fn(),
      enter = vi.fn();
    render(
      <WelcomeBack
        email="ada@example.com"
        npub={npubEncode("ab".repeat(32))}
        profile={{ name: "Ada", picture: "" }}
        onDevice={false}
        onRestore={backup ? restore : undefined}
        onImport={enter}
        onSwitchAccount={vi.fn()}
      />,
    );
    expect(screen.getByText("Signed in as ada@example.com")).toBeVisible();
    expect(
      screen.getByText(
        backup
          ? "Your account’s key isn’t on this device. Try restoring it from a backup, or enter its private key."
          : "Your account’s key isn’t on this device. Enter its private key to continue.",
      ),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Continue with Ada/ }));
    expect(restore).toHaveBeenCalledTimes(backup ? 1 : 0);
    expect(enter).toHaveBeenCalledTimes(backup ? 0 : 1);
    // With a restore offered, the key can still be entered without one.
    const enterRow = screen.queryByRole("button", {
      name: "Enter your private key",
    });
    expect(!!enterRow).toBe(backup);
    if (enterRow) {
      fireEvent.click(enterRow);
      expect(enter).toHaveBeenCalledTimes(1);
    }
    expect(screen.queryByText("I lost this key")).toBeNull();
    expect(screen.queryByText("Restore from backup")).toBeNull();
  },
);

it("shows the first and last ten public-key characters without inventing a profile name", () => {
  const npub = npubEncode("ab".repeat(32));
  render(
    <WelcomeBack
      npub={npub}
      onDevice
      onRestore={vi.fn()}
      onImport={vi.fn()}
      onSwitchAccount={vi.fn()}
    />,
  );
  expect(screen.getByText("We found the key to your account.")).toBeVisible();
  // The key is here: there is nothing to enter.
  expect(
    screen.queryByRole("button", { name: "Enter your private key" }),
  ).toBeNull();
  const label = `${npub.slice(0, 10)}...${npub.slice(-10)}`;
  expect(screen.getByText(label)).toBeVisible();
  expect(screen.getByText(label)).toHaveAttribute("title", npub);
  expect(
    screen.getByRole("button", { name: `Saved key, ${label}` }),
  ).toBeEnabled();
  expect(screen.queryByText("Buzz identity")).toBeNull();
});
