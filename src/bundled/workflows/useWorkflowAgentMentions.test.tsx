// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AgentDeclineNotes } from "../../features/messages/AgentDeclineNotes";

const native = vi.hoisted(() => ({ relayInfo: vi.fn() }));
vi.mock("../../features/relay/native", () => ({
  nativeRelayInfo: native.relayInfo,
}));
vi.mock("../../features/identity/service", () => ({
  nativeIdentityEnabled: () => true,
}));

const scope = `https://relay.example:${"d".repeat(64)}`;
const agent = "a".repeat(64);
const messages = ["1", "2", "3"].map((n) => n.repeat(64));
const session = {
  agentActivity: {
    snapshot: () => ({
      declined: messages.map((messageId) => ({
        scope,
        agent,
        channelId: "channel",
        messageId,
        refusal: "workflow",
      })),
    }),
    subscribe: () => () => {},
  },
} as never;
const notes = (ids = messages) =>
  ids.map((id) => (
    <AgentDeclineNotes
      key={id}
      session={session}
      scope={scope}
      channelId="channel"
      messageId={id}
    />
  ));
const owner = /limits which workflows/;

/** Mounts every note, removes one while the lookup is pending, then settles it. */
async function settleAfterRemoval(settle: () => void) {
  let done = () => {};
  const pending = new Promise<void>((resolve) => {
    done = resolve;
  });
  native.relayInfo.mockImplementationOnce(() => pending.then(settle));
  const view = render(notes());
  view.rerender(notes(messages.slice(1)));
  await act(async () => done());
}

it("shares one pending relay read across notes, and retries after a failure", async () => {
  await settleAfterRemoval(() => {
    throw new Error("offline");
  });
  expect(screen.getAllByRole("status")).toHaveLength(2);
  expect(screen.queryByText(owner)).toBeNull();
  cleanup();

  await settleAfterRemoval(() => ({ workflow_agent_mentions: "owner" }));
  expect(screen.getAllByText(owner)).toHaveLength(2);
  cleanup();

  render(notes());
  expect(await screen.findAllByText(owner)).toHaveLength(3);
  expect(native.relayInfo).toHaveBeenCalledTimes(2);
  expect(native.relayInfo).toHaveBeenCalledWith("https://relay.example");
});
