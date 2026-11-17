// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LocalDecline } from "../agents/local-activity";
import { AgentDeclineNotes } from "./AgentDeclineNotes";

const relay = vi.hoisted(() => ({ mode: "owner" }));
vi.mock("../../bundled/workflows/useWorkflowAgentMentions", () => ({
  useWorkflowAgentMentions: () => relay.mode,
}));
afterEach(() => {
  cleanup();
  relay.mode = "owner";
});
const agent = "a".repeat(64),
  other = "c".repeat(64),
  message = "b".repeat(64);
const choices = { identities: [{ pubkey: agent, name: "Builder" }] };
const session = (declined: LocalDecline[]) =>
  ({
    agentActivity: {
      snapshot: () => ({ declined }),
      subscribe: () => () => {},
    },
    agentChoices: {
      snapshot: () => choices,
      subscribe: () => () => {},
    },
  }) as never;
const decline = (refusal: LocalDecline["refusal"], who = agent) => ({
  scope: "s",
  agent: who,
  channelId: "channel",
  messageId: message,
  refusal,
});

it("says which agent didn't act and why", () => {
  render(
    <AgentDeclineNotes
      scope="s"
      session={session([decline("workflow", other)])}
      channelId="channel"
      messageId={message}
    />,
  );
  expect(
    screen.getByText(
      "Your agent didn't respond to this workflow message. This community limits which workflows can use agents, so other people can't use yours. If the workflow's Runs tab gives a reason, it's there.",
    ),
  ).toBeInTheDocument();
});

it("gives no community reason on a relay that lets any workflow direct agents", () => {
  relay.mode = "any";
  render(
    <AgentDeclineNotes
      scope="s"
      session={session([decline("workflow")])}
      channelId="channel"
      messageId={message}
    />,
  );
  expect(
    screen.getByText(
      "Builder didn't respond because this workflow message wasn't set up to direct agents.",
    ),
  ).toBeInTheDocument();
});

it("shows nothing for another message", () => {
  const { container } = render(
    <AgentDeclineNotes
      scope="s"
      session={session([decline("workflow")])}
      channelId="channel"
      messageId={other}
    />,
  );
  expect(container).toBeEmptyDOMElement();
});
