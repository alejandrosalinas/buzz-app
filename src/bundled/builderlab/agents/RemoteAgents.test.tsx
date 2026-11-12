// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { HostRequest, HostResponse } from "../../../features/host/service";
import { deferred, createTestSession } from "../test-helpers";
import { createAgentClient } from "./client";
import { RemoteAgents } from "./RemoteAgents";
import { ToastProvider } from "../../../shared/design-system/ui/Toast";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("reports an empty signed-out overview without starting a list request", async () => {
  const h = await fixture();
  h.session.signOut();
  const held = deferred<HostResponse>();
  h.request.mockReturnValue(held.promise);
  const overview = vi.fn();
  render(<RemoteAgents {...h} active={() => true} onOverview={overview} />);
  expect(overview).toHaveBeenLastCalledWith({ kind: "empty" });
  expect(h.request).not.toHaveBeenCalled();
  await act(async () => held.resolve(response([], 401)));
  expect(overview).toHaveBeenCalledTimes(1);
  expect(overview).toHaveBeenLastCalledWith({ kind: "empty" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
const row = {
  agent_id: "one",
  agent_name: "Helper",
  agent_pubkey: "ab".repeat(32),
  status: 2,
  model_selection_status: 1,
};
const response = (agents: unknown[], status = 200): HostResponse => ({
  status,
  headers: {},
  body: JSON.stringify({ status: 1, agents }),
});
async function fixture(canUseRemoteAgents = true) {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const session = createTestSession(
    async () => ({
      revision: "secret",
      account: {
        subject: "user",
        email: "a@example.com",
        canUseRemoteAgents,
        canUseBuilderlabDecisions: false,
      },
    }),
    undefined,
    { request: (input) => request(input) },
  );
  await session.signIn();
  const request = vi.fn(async (_input: HostRequest) => response([row]));
  const client = createAgentClient(session);
  return { session, client, request };
}
it("asks for sign-in only when signed out, not while a sign-in is pending", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const held = deferred<never>();
  const session = createTestSession(() => held.promise);
  render(
    <RemoteAgents
      session={session}
      client={createAgentClient(session)}
      active={() => true}
    />,
  );
  const prompt = "Sign in to view your remote agents.";
  expect(screen.getByText(prompt)).toBeVisible();
  const signIn = session.signIn();
  await waitFor(() => expect(session.snapshot().status).toBe("pending"));
  expect(screen.queryByText(prompt)).toBeNull();
  await act(async () => {
    held.reject(new Error("Sign-in failed. Try again."));
    await signIn;
  });
  expect(screen.getByText(prompt)).toBeVisible();
  session.dispose();
});
it("omits the agent summary when remote agents are unavailable", async () => {
  const h = await fixture(false);
  const overview = vi.fn();
  render(<RemoteAgents {...h} active={() => true} onOverview={overview} />);
  expect(screen.getByText("Unavailable for this account")).toBeVisible();
  expect(
    screen.queryByText("Agents", { selector: "dt" }),
  ).not.toBeInTheDocument();
  expect(overview).toHaveBeenLastCalledWith({ kind: "unavailable" });
  expect(h.request).not.toHaveBeenCalled();
});
it("loads automatically, refreshes and hides account data on sign-out", async () => {
  const h = await fixture();
  const overview = vi.fn();
  const openAgents = vi.fn();
  render(
    <RemoteAgents
      {...h}
      active={() => true}
      onOverview={overview}
      openAgents={openAgents}
    />,
  );
  expect(overview).toHaveBeenLastCalledWith({ kind: "pending" });
  expect(await screen.findByText("Helper")).toBeInTheDocument();
  expect(
    screen.queryByText("Agents", { selector: "dt" }),
  ).not.toBeInTheDocument();
  expect(overview).toHaveBeenLastCalledWith({
    kind: "filled",
    items: [{ key: "one", label: "Helper" }],
  });
  expect(h.request).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/Configured$/)).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "More actions for Helper" }),
  ).toBeEnabled();
  expect(document.body).not.toHaveTextContent("secret");
  const held = deferred<HostResponse>();
  h.request.mockReturnValueOnce(held.promise);
  const copy = screen.getByRole("button", { name: "More actions for Helper" });
  copy.focus();
  act(() => window.dispatchEvent(new Event("focus")));
  expect(copy).toHaveFocus();
  expect(screen.queryByText("Loading agents…")).not.toBeInTheDocument();
  expect(overview).toHaveBeenLastCalledWith({
    kind: "filled",
    items: [{ key: "one", label: "Helper" }],
  });
  await act(async () => held.resolve(response([row])));
  expect(copy).toHaveFocus();
  h.request.mockResolvedValueOnce(response([]));
  act(() => window.dispatchEvent(new Event("focus")));
  expect(await screen.findByText("No agents yet")).toBeInTheDocument();
  expect(overview).toHaveBeenLastCalledWith({ kind: "empty" });
  await userEvent.click(screen.getByRole("button", { name: "Open Agents" }));
  expect(openAgents).toHaveBeenCalledTimes(1);
  act(() => h.session.signOut());
  expect(
    screen.queryByRole("region", { name: "Remote agents" }),
  ).not.toBeInTheDocument();
});
it("shows a held loading state and retries a failed read", async () => {
  const h = await fixture();
  const held = deferred<HostResponse>();
  h.request.mockReturnValueOnce(held.promise);
  render(<RemoteAgents {...h} active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading agents");
  expect(
    screen.queryByRole("button", { name: "Refresh agents" }),
  ).not.toBeInTheDocument();
  await act(async () => held.resolve(response([], 400)));
  expect(
    screen.getByRole("heading", { name: "Couldn’t load agents" }),
  ).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent("HTTP 400");
  const automatic = deferred<HostResponse>();
  h.request.mockReturnValueOnce(automatic.promise);
  try {
    act(() => window.dispatchEvent(new Event("focus")));
    expect(screen.queryByText("Loading agents…")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("HTTP 400");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Helper")).toBeInTheDocument();
  } finally {
    await act(async () => automatic.resolve(response([], 400)));
  }
  expect(screen.getByText("Helper")).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it.each(["sign-out", "unmount"])(
  "ignores held reads after %s",
  async (action) => {
    const h = await fixture();
    const held = deferred<HostResponse>();
    h.request.mockReturnValue(held.promise);
    const mounted = render(<RemoteAgents {...h} active={() => true} />);
    if (action === "sign-out") act(() => h.session.signOut());
    else mounted.unmount();
    await act(async () => held.resolve(response([row])));
    expect(screen.queryByText("Helper")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  },
);

it("copies the agent key and exposes a recoverable clipboard failure", async () => {
  const h = await fixture();
  const writeText = vi
    .fn()
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(
    <ToastProvider>
      <RemoteAgents {...h} active={() => true} />
    </ToastProvider>,
  );
  const copy = await screen.findByRole("button", {
    name: "More actions for Helper",
  });
  const copyKey = async () => {
    await userEvent.click(copy);
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Copy key" }),
    );
  };
  await copyKey();
  expect(
    await screen.findByRole("dialog", { name: "Couldn’t copy the key" }),
  ).toHaveTextContent("Couldn’t copy the key");
  expect(screen.queryByText(row.agent_pubkey)).not.toBeInTheDocument();
  await copyKey();
  expect(screen.getByRole("dialog", { name: "Key copied" })).toHaveTextContent(
    "Key copied",
  );
  expect(writeText).toHaveBeenLastCalledWith(row.agent_pubkey);
  const held = deferred<HostResponse>();
  h.request.mockReturnValueOnce(held.promise);
  copy.focus();
  act(() => window.dispatchEvent(new Event("focus")));
  await act(async () => held.resolve(response([], 400)));
  await waitFor(() => expect(copy).toHaveFocus());
  expect(screen.getByRole("dialog", { name: "Key copied" })).toHaveTextContent(
    "Key copied",
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it.each([
  [2, 1, "Configured"],
  [2, 2, "Needs setup"],
  [2, undefined, "Needs setup"],
  [1, 1, "Needs setup"],
  [3, 1, "Revoked"],
  [0, 1, "Unknown"],
])(
  "shows readiness for agent %s and model %s",
  async (status, model, label) => {
    const h = await fixture();
    h.request.mockResolvedValue(
      response([
        {
          ...row,
          status,
          model_selection_status: model,
          created_at: "2026-07-15T12:00:00Z",
        },
      ]),
    );
    render(<RemoteAgents {...h} active={() => true} />);
    expect(await screen.findByText(new RegExp(`${label}$`))).toBeVisible();
  },
);

it("uses saved avatars and opens saved rows independently of their action menus", async () => {
  const h = await fixture();
  const openAgent = vi.fn();
  const picture = "https://example.com/helper.png";
  let active = true;
  const props = { ...h, active: () => active, openAgent };
  const view = render(
    <RemoteAgents
      {...props}
      savedAgents={[{ pubkey: row.agent_pubkey, picture }]}
    />,
  );
  const open = await screen.findByRole("button", {
    name: "View Helper",
  });
  const image = screen.getByText("Helper").closest("li")?.querySelector("img");
  expect(open).toHaveAccessibleDescription(/Configured/);
  expect(screen.getByText("In Agents")).toBeVisible();
  expect(image).toHaveAttribute("src", picture);
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "More actions for Helper" }),
  );
  expect(
    await screen.findByRole("menuitem", { name: "View Agent" }),
  ).toBeVisible();
  await user.click(screen.getByRole("menuitem", { name: "Copy key" }));
  expect(openAgent).not.toHaveBeenCalled();
  await user.click(open);
  open.focus();
  await user.keyboard("{Enter}");
  expect(openAgent.mock.calls).toEqual([
    [row.agent_pubkey],
    [row.agent_pubkey],
  ]);
  active = false;
  await user.click(open);
  expect(openAgent).toHaveBeenCalledTimes(2);
  view.rerender(<RemoteAgents {...props} savedAgents={[]} />);
  expect(screen.queryByRole("button", { name: "View Helper" })).toBeNull();
  expect(screen.queryByText("In Agents")).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "More actions for Helper" }),
  );
  expect(
    await screen.findByRole("menuitem", { name: "Copy key" }),
  ).toBeVisible();
  expect(screen.queryByRole("menuitem", { name: "View Agent" })).toBeNull();
  expect(
    view.container.querySelector("img[src='https://example.com/helper.png']"),
  ).toBeNull();
});
