// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Agents, TeamUpdateRequest } from "../../features/agents/service";
import { TeamUpdateReview } from "./TeamUpdateReview";

const request: TeamUpdateRequest = {
  id: "draft",
  requester: "a".repeat(64),
  requesterName: "Paul",
  owner: "o".repeat(64),
  community: "https://relay.example",
  team: "t",
  base: { name: "Crew", instructions: "Ship.", revision: "r" },
  instructions: "Ship carefully.",
};

afterEach(cleanup);

function setup(approve = vi.fn(async () => {})) {
  let requests: readonly TeamUpdateRequest[] = [request];
  const listeners = new Set<() => void>();
  const agents = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    teamUpdateRequests: () => requests,
    dismissTeamUpdate: vi.fn(() => {
      requests = [];
      for (const listener of listeners) listener();
    }),
    approveTeamUpdate: approve,
  } as unknown as Agents;
  render(<TeamUpdateReview agents={agents} />);
  return agents;
}

it("saves what the owner reviewed, filled in with the proposal", async () => {
  const user = userEvent.setup();
  const agents = setup();
  expect(
    await screen.findByText(
      "Paul proposed these changes. Nothing changes until you save.",
    ),
  ).toBeVisible();
  expect(screen.getByLabelText("Name")).toHaveValue("Crew");
  const instructions = screen.getByLabelText("Instructions");
  expect(instructions).toHaveValue("Ship carefully.");
  await user.clear(instructions);
  await user.type(instructions, "Ship.{Enter}Test first.");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(agents.approveTeamUpdate).toHaveBeenCalledWith("draft", {
    name: "Crew",
    instructions: "Ship.\nTest first.",
  });
});

it("shows a refused save and discards the request on close", async () => {
  const user = userEvent.setup();
  const agents = setup(
    vi.fn(async () => {
      throw new Error("The team changed since this was proposed");
    }),
  );
  await user.click(await screen.findByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("changed since");
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(agents.dismissTeamUpdate).toHaveBeenCalledWith("draft");
});
