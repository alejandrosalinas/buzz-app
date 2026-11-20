// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayData } from "../../features/relay/service";
import type { Navigation } from "../../features/navigation/controller";
import type { ChannelSummary } from "../../features/relay/contracts";
import { newMessageTarget } from "../../features/channel-navigation/routes";
import { AgentMessageButton } from "./AgentMessageButton";
afterEach(cleanup);
const owner = "1".repeat(64);
const agent = "2".repeat(64);
const scope = { viewer: owner, communityOrigin: "https://community.example" };
/** With `dm`, the viewer already has a DM with the agent. */
function setup({ dm = true } = {}) {
  const open = vi.fn(
    async (_keys: string[], _signal: AbortSignal) => "dm-agent",
  );
  const navigate = vi.fn(async () => ({ status: "opened" }));
  const choices: {
    identities: { pubkey: string; managed: boolean; messageable?: true }[];
    pending?: boolean;
    error?: string;
  } = { identities: [{ pubkey: agent, managed: true }] };
  const refresh = vi.fn(async () => {});
  const channels: ChannelSummary[] = dm
    ? [
        {
          id: "dm-agent",
          name: "Agent",
          channelType: "dm",
          participants: [agent],
        },
      ]
    : [];
  const snapshot = {
    status: "ready",
    generation: 1,
    viewer: owner,
    origin: "https://community.example",
    session: {
      channels: { list: () => ({ channels }) },
      directMessages: { available: true, open },
      agentChoices: {
        snapshot: () => choices,
        refresh,
      },
    },
  };
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
  const current = { kind: "agent" };
  const navigator = {
    open: navigate,
    snapshot: () => ({ entry: { target: current } }),
  } as unknown as Navigation;
  return {
    open,
    navigate,
    relay,
    navigator,
    current,
    choices,
    refresh,
    channels,
  };
}
it("opens a completed hosted agent without local custody", async () => {
  const f = setup({ dm: false });
  f.choices.identities = [{ pubkey: agent, managed: false, messageable: true }];
  render(<AgentMessageButton {...f} pubkey={agent} navigation={undefined} />);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Message" }));
  expect(f.open).not.toHaveBeenCalled();
  expect(f.navigate).toHaveBeenCalledExactlyOnceWith(
    newMessageTarget(scope, agent, expect.any(Number)),
  );
  expect(f.refresh).not.toHaveBeenCalled();
});
it("reopens an existing hidden DM without agent-control evidence", async () => {
  const f = setup({ dm: false });
  f.choices.identities = [];
  f.channels.push({
    id: "dm-agent",
    name: "Agent",
    channelType: "dm",
    hidden: true,
    participants: [agent],
  });
  render(<AgentMessageButton {...f} pubkey={agent} navigation={undefined} />);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Message" }));
  expect(f.open).toHaveBeenCalledOnce();
  expect(f.navigate).toHaveBeenCalledOnce();
});
it("offers refresh and retry when agent evidence is unavailable", async () => {
  const f = setup({ dm: false });
  f.choices.identities = [];
  f.choices.pending = true;
  f.refresh.mockImplementationOnce(async () => {
    f.choices.identities = [
      { pubkey: agent, managed: false, messageable: true },
    ];
    f.choices.pending = false;
  });
  const user = userEvent.setup();
  render(<AgentMessageButton {...f} pubkey={agent} navigation={undefined} />);
  await user.click(screen.getByRole("button", { name: "Message" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Agent details are still loading",
  );
  expect(f.open).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(f.refresh).toHaveBeenCalledOnce();
  expect(f.open).not.toHaveBeenCalled();
  expect(f.navigate).toHaveBeenCalledOnce();
});
it("keeps a library-only agent blocked after refreshing", async () => {
  const f = setup({ dm: false });
  f.choices.identities = [{ pubkey: agent, managed: false }];
  const user = userEvent.setup();
  render(<AgentMessageButton {...f} pubkey={agent} navigation={undefined} />);
  await user.click(screen.getByRole("button", { name: "Message" }));
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(f.refresh).toHaveBeenCalledOnce();
  expect(f.open).not.toHaveBeenCalled();
  expect(f.navigate).not.toHaveBeenCalled();
});
it("does not treat an archived DM as a conversation to reopen", async () => {
  const f = setup({ dm: false });
  f.choices.identities = [];
  f.channels.push({
    id: "dm-agent",
    name: "Agent",
    channelType: "dm",
    archived: true,
    participants: [agent],
  });
  render(<AgentMessageButton {...f} pubkey={agent} navigation={undefined} />);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Message" }));
  expect(f.open).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("unavailable");
});
it("retires a retry that is still refreshing when the profile closes", async () => {
  const f = setup({ dm: false });
  f.choices.identities = [];
  let finish!: () => void;
  f.refresh.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const user = userEvent.setup();
  const view = render(
    <AgentMessageButton {...f} pubkey={agent} navigation={undefined} />,
  );
  await user.click(screen.getByRole("button", { name: "Message" }));
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(f.refresh).toHaveBeenCalledOnce();
  view.unmount();
  f.choices.identities = [{ pubkey: agent, managed: false, messageable: true }];
  await act(async () => finish());
  expect(f.open).not.toHaveBeenCalled();
  expect(f.navigate).not.toHaveBeenCalled();
});
it("opens the agent conversation in the current community without sending a message", async () => {
  const user = userEvent.setup();
  const f = setup();
  render(<AgentMessageButton {...f} pubkey={agent} navigation={undefined} />);
  await user.click(screen.getByRole("button", { name: "Message" }));
  expect(f.open).toHaveBeenCalledWith([agent], expect.any(AbortSignal));
  expect(f.navigate).toHaveBeenCalledWith({
    version: 1,
    kind: "conversation",
    channelId: "dm-agent",
    scope,
  });
});
it("shows an opening error and allows retry", async () => {
  const user = userEvent.setup();
  const f = setup();
  f.open.mockRejectedValueOnce(new Error("Could not open chat"));
  render(<AgentMessageButton {...f} pubkey={agent} navigation={undefined} />);
  await user.click(screen.getByRole("button", { name: "Message" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not open chat",
  );
  await user.click(screen.getByRole("button", { name: "Message" }));
  await waitFor(() => expect(f.navigate).toHaveBeenCalledOnce());
});
it("cancels an opening when the profile is closed", async () => {
  const user = userEvent.setup();
  const f = setup();
  let finish!: (channel: string) => void;
  f.open.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(
    <AgentMessageButton {...f} pubkey={agent} navigation={undefined} />,
  );
  await user.click(screen.getByRole("button", { name: "Message" }));
  view.unmount();
  expect(f.open.mock.calls[0]?.[1].aborted).toBe(true);
  await act(async () => finish("dm-agent"));
  expect(f.navigate).not.toHaveBeenCalled();
});
it("leaves Settings in place when an opening finishes behind it", async () => {
  const user = userEvent.setup();
  const f = setup();
  let finish!: (channel: string) => void;
  f.open.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<AgentMessageButton {...f} pubkey={agent} navigation={undefined} />);
  await user.click(screen.getByRole("button", { name: "Message" }));
  f.current.kind = "settings";
  await act(async () => finish("dm-agent"));
  expect(f.navigate).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Message" })).toBeEnabled();
});
