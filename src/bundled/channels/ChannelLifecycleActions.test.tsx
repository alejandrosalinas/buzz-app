// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelLifecycleCapability } from "../../features/relay/channel-lifecycle";
import type { ChannelSummary } from "../../features/relay/contracts";
import { ChannelLifecycleActions } from "./ChannelLifecycleActions";

afterEach(cleanup);
const viewer = "a".repeat(64),
  other = "b".repeat(64);
const channel = (overrides: Partial<ChannelSummary> = {}): ChannelSummary => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Fixture",
  channelType: "stream",
  viewerRole: "member",
  members: [viewer, other],
  owners: [other],
  ...overrides,
});
function session(available = true) {
  const lifecycle = {
    available,
    load: vi.fn<ChannelLifecycleCapability["load"]>(),
    run: vi.fn<ChannelLifecycleCapability["run"]>(),
    snapshot: () => ({ status: "ready", hidden: [] }),
    subscribe: () => () => {},
    observeRemoval: () => () => {},
    refreshVisibility: async () => {},
  } satisfies ChannelLifecycleCapability;
  return {
    viewer,
    channelLifecycle: lifecycle,
    profiles: {
      snapshot: () => new Map(),
      subscribe: () => () => {},
      ensure: vi.fn(async () => {}),
    },
  };
}

it("offers permitted actions at once and hands the trigger to the existing confirmation, without reading or writing", async () => {
  const host = session();
  const choose = vi.fn();
  render(
    <ChannelLifecycleActions
      channel={channel()}
      session={host}
      choose={choose}
    />,
  );
  const button = screen.getByRole("button", { name: "Leave channel" });
  expect(screen.getAllByRole("button")).toHaveLength(1);
  button.focus();
  await userEvent.setup().keyboard("{Enter}");
  expect(choose).toHaveBeenCalledWith("leave", button);
  expect(host.channelLifecycle.load).not.toHaveBeenCalled();
  expect(host.channelLifecycle.run).not.toHaveBeenCalled();
});
it("lets a last owner archive or delete but omits Leave without an explanation", () => {
  render(
    <ChannelLifecycleActions
      channel={channel({ viewerRole: "owner", owners: [viewer] })}
      session={session()}
      choose={vi.fn()}
    />,
  );
  expect(screen.getAllByRole("button").map((item) => item.textContent)).toEqual(
    ["Archive channel", "Delete channel"],
  );
  expect(
    screen.queryByText("Transfer ownership before leaving the channel."),
  ).toBeNull();
});
it("replaces Archive with Unarchive when the live channel is archived", () => {
  const host = session();
  const view = render(
    <ChannelLifecycleActions
      channel={channel({ viewerRole: "admin" })}
      session={host}
      choose={vi.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: "Archive channel" })).toBeVisible();
  view.rerender(
    <ChannelLifecycleActions
      channel={channel({ viewerRole: "admin", archived: true })}
      session={host}
      choose={vi.fn()}
    />,
  );
  expect(screen.queryByRole("button", { name: "Archive channel" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Unarchive channel" }),
  ).toBeVisible();
});
it("explains an unsupported host without a lookup or write", () => {
  const host = session(false);
  render(
    <ChannelLifecycleActions
      channel={channel()}
      session={host}
      choose={vi.fn()}
    />,
  );
  expect(
    screen.getByText("Channel actions unavailable on this connection"),
  ).toBeVisible();
  expect(screen.queryByRole("button")).toBeNull();
  expect(host.channelLifecycle.load).not.toHaveBeenCalled();
  expect(host.channelLifecycle.run).not.toHaveBeenCalled();
});
