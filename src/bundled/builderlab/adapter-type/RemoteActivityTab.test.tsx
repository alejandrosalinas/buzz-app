// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent } from "../../../features/agents/service";
import type { RelayData } from "../../../features/relay/service";
import type { AgentClient } from "../agents/client";
import type { BuilderlabSession } from "../session";
import type { AgentActivity } from "./Activity";
import { createRemoteActivityTab } from "./RemoteActivityTab";

afterEach(cleanup);

const pubkey = "a".repeat(64);
const agent = {
  key: pubkey,
  pubkey,
  name: "Ada",
  relay: "wss://relay.example.org",
} as unknown as Agent;
const activity = {
  snapshot: () => feed,
  subscribe: () => () => {},
  activate: vi.fn(),
} as unknown as AgentActivity;
const feed = {
  status: "listening",
  records: [],
  turns: [],
  typing: [],
  trimmed: 0,
};
const connection = { status: "ready", session: { agentActivity: activity } };
const relay = {
  snapshot: () => connection,
  subscribe: () => () => {},
} as unknown as RelayData;
const login = {
  status: "signed-in",
  account: { subject: "owner", canUseRemoteAgents: true },
};
const session = {
  snapshot: () => login,
  subscribe: () => () => {},
} as unknown as BuilderlabSession;

function tab(sessions: AgentClient["sessions"]) {
  const client = {
    list: vi.fn(async (signal: AbortSignal) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
      return [{ id: "agent-1", pubkey }];
    }),
    sessions: vi.fn(sessions),
  } as unknown as AgentClient;
  return createRemoteActivityTab(relay, client, session);
}

it("answers a pending transcript request when Builderlab stores no sessions", async () => {
  const Tab = tab(async () => {
    throw Object.assign(new Error("missing"), { status: 404 });
  });
  const done = vi.fn();
  render(
    <Tab
      agent={agent}
      conversation={{ channelId: "alpha" }}
      initialTranscript={{ opening: 1, done }}
      save={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Live activity" }),
  ).toBeInTheDocument();
  await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("heading", { name: "Live activity" })).toBeNull();
  expect(
    screen.queryByRole("heading", { name: "Recent conversations" }),
  ).toBeNull();
});

it("drops the list read StrictMode aborts", async () => {
  const Tab = tab(async () => ({ sessions: [], cursor: undefined }));
  render(
    <StrictMode>
      <Tab agent={agent} save={vi.fn()} />
    </StrictMode>,
  );
  expect(
    await screen.findByText("No other conversations stored yet."),
  ).toBeInTheDocument();
  await new Promise((resolve) => setTimeout(resolve, 10));
});
