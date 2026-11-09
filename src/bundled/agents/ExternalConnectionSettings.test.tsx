// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { ExternalConnectionSettings } from "./ExternalConnectionSettings";
import { createExternalApps } from "../../features/agents/external-connection";
afterEach(cleanup);
it("shows an authorized app after settings reopen and lets the owner revoke it", async () => {
  let signal: AbortSignal | undefined;
  let stopped!: () => void;
  const closed = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const connection = createExternalApps();
  connection.bind({
    connect: async (_key, lifetime) => {
      signal = lifetime;
      return {
        url: "http://127.0.0.1:1234/mcp",
        headers: [],
        closed,
        close: async () => stopped(),
        authorize: async () => {},
      };
    },
    deny: async () => {},
  });
  connection.open(
    {
      version: 1,
      client: "Test client",
      callback: "http://127.0.0.1:1234/buzz/authorize",
      state: "A".repeat(43),
      scope: ["agent"],
      code_challenge: "A".repeat(43),
      code_challenge_method: "S256",
    },
    "viewer",
  );
  await connection.approve("test-agent");
  const first = render(<ExternalConnectionSettings connection={connection} />);
  expect(screen.getByText("Test client")).toBeVisible();
  first.unmount();
  render(<ExternalConnectionSettings connection={connection} />);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Revoke access" }));
  expect(signal?.aborted).toBe(true);
  expect(screen.getByRole("status")).toHaveTextContent(
    "No external app has access.",
  );
  await act(async () => closed);
});

it("asks for new setup when a saved approval has only older, limited access", async () => {
  const connection = createExternalApps();
  connection.bind({
    connect: async () => {
      throw new Error("not used");
    },
    deny: async () => {},
    pairing: async () => ({
      id: "C".repeat(43),
      approval: {
        client: "Old client",
        viewer: "viewer",
        agent: "test-agent",
        community: "https://example.test",
        scopes: ["read", "post"],
      },
      expires_at: 2_000_000_000,
    }),
  });
  render(<ExternalConnectionSettings connection={connection} />);
  expect(
    await screen.findByText(/older approval gives limited access/),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Revoke access" })).toBeVisible();
});
