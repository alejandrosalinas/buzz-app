// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Recovery } from "./builderlab-account";
import { KeyRestore } from "./KeyRestore";
import type { RecoveryState } from "./service";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));
afterEach(cleanup);

const linked = "a".repeat(64);
const other = "b".repeat(64);
function recovery(state: RecoveryState, canceled = true) {
  return {
    subscribe: () => () => {},
    snapshot: () => state,
    beginRecovery: vi.fn(async () => {}),
    installRecovery: vi.fn(async () => {}),
    cancelRecovery: vi.fn(async () => canceled),
  } satisfies Recovery;
}
function mount(state: RecoveryState, canceled?: boolean) {
  const stub = recovery(state, canceled);
  render(
    <KeyRestore
      recovery={stub}
      expectedPubkey={linked}
      onBack={() => {}}
      onImport={() => {}}
      onInstalled={() => {}}
    />,
  );
  return stub;
}
const unmatched = (failedCount: number): RecoveryState => ({
  status: "choosing",
  candidates: [{ handle: "h1", pubkey: other }],
  currentPubkey: null,
  failedCount,
});

it("when every backup came back and none holds the linked key, offers only Enter my private key", () => {
  mount(unmatched(0));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "We found backups, but none contains the key linked to your account. Enter your private key to continue.",
  );
  expect(
    screen.getByRole("button", { name: "Enter my private key" }),
  ).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(
    screen.queryByText("Your key is stored securely on this device."),
  ).toBeNull();
});

it("when a backup failed to come back, does not claim none holds the key and retries over the live attempt", async () => {
  const stub = mount(unmatched(1));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "We couldn’t check all your backups. Try again, or enter your private key if you have a copy.",
  );
  expect(
    screen.getByRole("button", { name: "Enter my private key" }),
  ).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  // The service refuses a new attempt over one that recovered something:
  // the retry cancels first, then begins.
  await waitFor(() => expect(stub.beginRecovery).toHaveBeenCalledTimes(1));
  expect(stub.cancelRecovery).toHaveBeenCalledTimes(1);
  expect(stub.cancelRecovery.mock.invocationCallOrder).toEqual([
    expect.any(Number),
  ]);
  const [cancelOrder] = stub.cancelRecovery.mock.invocationCallOrder;
  const [beginOrder] = stub.beginRecovery.mock.invocationCallOrder;
  expect(cancelOrder).toBeLessThan(beginOrder ?? -1);
});

it.each([
  "Restore was canceled. Try again.",
  "Sign-in timed out. Try again.",
  "Couldn't reach Builderlab. Check your connection and try again.",
])("names why the restore failed: %s", async (error) => {
  const stub = mount({ status: "error", error });
  expect(screen.getByRole("alert")).toHaveTextContent(
    `${error} Or enter your private key if you have a copy.`,
  );
  expect(
    screen.getByRole("button", { name: "Enter my private key" }),
  ).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(stub.beginRecovery).toHaveBeenCalledTimes(1));
});

it("keeps manual key entry, not a retry, when backup recovery is unavailable", () => {
  mount({ status: "error", error: "Backup recovery is unavailable." });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Backup restoration isn’t available for this account. Enter your private key to continue.",
  );
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

it("starts no new attempt when the live one could not be canceled", async () => {
  const stub = mount(unmatched(1), false);
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(stub.cancelRecovery).toHaveBeenCalledTimes(1));
  expect(stub.beginRecovery).not.toHaveBeenCalled();
});

it("restores the already selected linked identity without a second choice", async () => {
  const stub = mount({
    status: "choosing",
    candidates: [
      { handle: "other", pubkey: other },
      { handle: "linked", pubkey: linked },
    ],
    currentPubkey: other,
    failedCount: 0,
  });
  await waitFor(() =>
    expect(stub.installRecovery).toHaveBeenCalledExactlyOnceWith("linked"),
  );
  expect(
    screen.queryByRole("button", { name: "Restore this identity" }),
  ).toBeNull();
  expect(screen.queryByRole("radiogroup")).toBeNull();
});

it("retries installation when a new attempt returns the same handle", async () => {
  const candidate: RecoveryState = {
    status: "choosing",
    candidates: [{ handle: "same", pubkey: linked }],
    currentPubkey: null,
    failedCount: 0,
  };
  let state: RecoveryState = candidate;
  const listeners = new Set<() => void>();
  const update = (next: RecoveryState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const stub: Recovery = {
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    installRecovery: vi.fn(async () => {
      update({ status: "error", error: "Could not save key" });
    }),
    cancelRecovery: vi.fn(async () => true),
    beginRecovery: vi.fn(async () => {
      update(candidate);
    }),
  };
  render(
    <KeyRestore
      recovery={stub}
      expectedPubkey={linked}
      onBack={() => {}}
      onImport={() => {}}
      onInstalled={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "Couldn’t restore your key" });
  expect(stub.installRecovery).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(stub.installRecovery).toHaveBeenCalledTimes(2));
  expect(stub.cancelRecovery).toHaveBeenCalledTimes(1);
});
