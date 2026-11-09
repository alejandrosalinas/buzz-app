// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentViewProps } from "../../features/agents/service";
import { meshAgentConfig, type MeshAgentConfig } from "./meshAgent";
import type { MeshHistory } from "./meshTranscript";
import { createMeshTranscriptTab } from "./MeshTranscriptTab";

afterEach(cleanup);
const props = {
  agent: {
    key: "agent",
    pubkey: "agent",
    name: "Mesh helper",
    config: meshAgentConfig({}),
  },
  save: vi.fn(),
} as unknown as AgentViewProps<MeshAgentConfig>;
const row = {
  sessionId: "s1",
  title: "saved",
  at: 1791940000000,
  channelId: "channel",
};
const transcript = { turns: [], more: false };

it("shows a held read, then a read-only saved transcript using host components", async () => {
  let release!: (value: typeof transcript) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<typeof transcript>((resolve) => {
    release = resolve;
  });
  const history = {
    recent: vi.fn(async () => [row]),
    transcript: vi.fn(() => {
      entered();
      return gate;
    }),
  };
  const Tab = createMeshTranscriptTab(history as unknown as MeshHistory);
  render(<Tab {...props} />);
  try {
    await waitFor(() => expect(history.transcript).toHaveBeenCalled());
    await started;
    expect(screen.getByRole("status")).toHaveTextContent(
      "Reading saved Mesh sessions",
    );
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await act(async () => {
      release(transcript);
      await gate;
    });
    expect(await screen.findByText(/Saved snapshot/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  } finally {
    release(transcript);
  }
});

it("offers refresh after a read failure and distinguishes empty history", async () => {
  const history = {
    recent: vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([]),
    transcript: vi.fn(),
  };
  const Tab = createMeshTranscriptTab(history as unknown as MeshHistory);
  render(<Tab {...props} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText(/No matching Mesh sessions/)).toBeVisible();
  expect(history.transcript).not.toHaveBeenCalled();
});

it("does not display a late result after the viewed agent changes", async () => {
  let release!: (value: typeof transcript) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<typeof transcript>((resolve) => {
    release = resolve;
  });
  const history = {
    recent: vi.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce([]),
    transcript: vi.fn(() => {
      entered();
      return gate;
    }),
  };
  const Tab = createMeshTranscriptTab(history as unknown as MeshHistory);
  const mounted = render(<Tab {...props} />);
  try {
    await waitFor(() => expect(history.transcript).toHaveBeenCalled());
    await started;
    mounted.rerender(
      <Tab {...props} agent={{ ...props.agent, key: "other" }} />,
    );
    await screen.findByText(/No matching Mesh sessions/);
    await act(async () => {
      release(transcript);
      await gate;
    });
    expect(screen.queryByText(/Saved snapshot/)).not.toBeInTheDocument();
  } finally {
    release(transcript);
  }
});
