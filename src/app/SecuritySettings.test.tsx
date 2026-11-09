// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SecuritySettings } from "./SecuritySettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const tool = {
  id: "p1",
  client: "buzz-cli",
  relay: "wss://relay.example/",
  created: 1_800_000_000,
  lastUsed: 1_800_000_000,
  expires: 1_802_592_000,
};
beforeEach(() => {
  vi.mocked(listen).mockResolvedValue(() => {});
});
afterEach(cleanup);

it("lists paired tools and revokes one", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "credential_pairings_list" ? [tool] : undefined,
  );
  render(<SecuritySettings />);
  expect(await screen.findByText("buzz-cli")).toBeInTheDocument();
  expect(
    screen.getByText(/wss:\/\/relay\.example\/ · Paired/),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
  expect(invoke).toHaveBeenCalledWith("credential_pairing_revoke", {
    id: "p1",
  });
  expect(screen.queryByText("buzz-cli")).toBeNull();
});

it("keeps the row and says why when revoking fails", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "credential_pairings_list") return [tool];
    throw "Paired tools could not be saved to secure storage";
  });
  render(<SecuritySettings />);
  await userEvent.click(await screen.findByRole("button", { name: "Revoke" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "could not be saved",
  );
  expect(screen.getByText("buzz-cli")).toBeInTheDocument();
});

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
