// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AgentArchiveRetry, AgentDelete, AgentRemoveHere } from "./AgentManage";
import type { Agent, Agents } from "./service";

afterEach(cleanup);

const agent = {
  key: "1".repeat(64),
  pubkey: "1".repeat(64),
  name: "Ada",
  type: "test/echo",
  owner: "f".repeat(64),
  relay: "wss://relay.example",
  place: "here",
  config: {},
  attention: {},
  skipped: {},
  timers: {},
  attentionEnabled: true,
} satisfies Agent;

it("deletes after confirming, and keeps the dialog open with the error when Delete fails", async () => {
  const user = userEvent.setup();
  const remove = vi
    .fn<Agents["remove"]>()
    .mockRejectedValueOnce(new Error("Credential store refused"))
    .mockResolvedValueOnce(undefined);
  const onRemoved = vi.fn();
  render(
    <AgentDelete
      agents={{ remove, memberships: () => [] } as unknown as Agents}
      agent={agent}
      onRemoved={onRemoved}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Delete agent" }));
  await user.click(screen.getByRole("button", { name: "Delete" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Credential store refused",
  );
  expect(onRemoved).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Delete" }));
  await vi.waitFor(() => expect(onRemoved).toHaveBeenCalledOnce());
  expect(remove).toHaveBeenCalledWith(agent.key);
});

it("retries an unchecked archive state and shows what is left", async () => {
  const user = userEvent.setup();
  const unarchive = vi
    .fn<Agents["unarchive"]>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce("Ada is still archived.");
  const { rerender } = render(
    <AgentArchiveRetry agents={{ unarchive }} agent={agent} />,
  );
  expect(screen.queryByText("Archive state")).toBeNull();
  rerender(
    <AgentArchiveRetry
      agents={{ unarchive }}
      agent={{ ...agent, archiveUnchecked: true }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByText("Couldn't check whether it's archived: offline"),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Ada is still archived.")).toBeVisible();
  expect(unarchive).toHaveBeenCalledWith(agent.key);
});

it.each(["delete", "remove"] as const)(
  "%s starts on Cancel and Enter leaves the agent unchanged",
  async (action) => {
    const user = userEvent.setup();
    const remove = vi.fn();
    const leave = vi.fn();
    const onRemoved = vi.fn();
    const agents = {
      remove,
      leave,
      memberships: () => [],
    } as unknown as Agents;
    const props = { agents, agent, onRemoved };
    render(
      action === "delete" ? (
        <AgentDelete {...props} />
      ) : (
        <AgentRemoveHere
          {...props}
          trigger={(open) => (
            <button type="button" onClick={open}>
              Remove agent
            </button>
          )}
        />
      ),
    );
    const trigger = screen.getByRole("button", {
      name: action === "delete" ? "Delete agent" : "Remove agent",
    });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Cancel" }),
      ).toHaveFocus(),
    );
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
    expect(remove).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
    expect(onRemoved).not.toHaveBeenCalled();
  },
);
