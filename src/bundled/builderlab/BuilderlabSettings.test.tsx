// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useEffect, type ReactNode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { BuilderlabSettings, ManagementHeader } from "./BuilderlabSettings";
import { Login } from "./login/Login";
import { createTestSession } from "./test-helpers";
import type { Credential } from "./session";
import { deferred } from "./test-helpers";

afterEach(cleanup);

it("opens sections by keyboard, restores card focus and preserves management drafts", async () => {
  const started = vi.fn();
  function Communities({ navigation }: { navigation: ReactNode }) {
    useEffect(started, []);
    return (
      <>
        <ManagementHeader title="Communities" navigation={navigation} />
        <input aria-label="Community address" />
      </>
    );
  }
  render(
    <BuilderlabSettings
      active={() => true}
      account={<p>Account sign-in</p>}
      communities={(navigation) => <Communities navigation={navigation} />}
      agents={<p>Agent list</p>}
      summaries={{
        agents: { kind: "filled", items: [{ key: "one", label: "Helper" }] },
        communities: { kind: "empty" },
      }}
    />,
  );
  const user = userEvent.setup();
  expect(screen.queryByRole("heading", { name: "Account" })).toBeNull();
  expect(
    screen
      .getByText("Account sign-in")
      .compareDocumentPosition(
        screen.getByRole("region", { name: "Communities" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const communities = within(
    screen.getByRole("region", { name: "Communities" }),
  ).getByRole("button", { name: /^Open / });
  expect(started).toHaveBeenCalledTimes(1);
  communities.focus();
  await user.keyboard("{Enter}");
  expect(started).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Account sign-in")).not.toBeVisible();
  expect(
    screen.getByRole("button", { name: "Back to Builderlab" }),
  ).toHaveFocus();
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
    "Communities",
  );
  expect(
    screen.getByRole("button", { name: "Back to Builderlab" }),
  ).toHaveTextContent(/^$/);
  await user.type(screen.getByRole("textbox"), "my-community");
  await user.click(screen.getByRole("button", { name: "Back to Builderlab" }));
  expect(communities).toHaveFocus();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  await user.click(
    within(screen.getByRole("region", { name: "Remote agents" })).getByRole(
      "button",
      { name: /^Open / },
    ),
  );
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
    "Remote agents",
  );
  expect(screen.getByText("Agent list")).toBeVisible();
  expect(
    screen.getByRole("heading", { name: "Remote agents (1)" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Back to Builderlab" }));
  expect(
    within(screen.getByRole("region", { name: "Remote agents" })).getByRole(
      "button",
      { name: /^Open / },
    ),
  ).toHaveFocus();
  await user.click(communities);
  expect(screen.getByRole("textbox")).toHaveValue("my-community");
  expect(started).toHaveBeenCalledTimes(1);
});

it("keeps a pending login mounted while navigating between management and overview", async () => {
  const held = deferred<Credential>();
  const acquire = vi.fn(() => held.promise);
  const session = createTestSession(acquire);
  render(
    <BuilderlabSettings
      active={() => true}
      account={
        <Login
          session={session}
          available
          active={() => true}
          showHeading={false}
        />
      }
      communities={() => <p>Community list</p>}
      agents={<p>Agent list</p>}
    />,
  );
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  );
  await user.click(
    within(screen.getByRole("region", { name: "Remote agents" })).getByRole(
      "button",
      { name: /^Open / },
    ),
  );
  expect(session.snapshot().status).toBe("pending");
  await user.click(screen.getByRole("button", { name: "Back to Builderlab" }));
  expect(session.snapshot().status).toBe("pending");
  await act(async () =>
    held.resolve({
      revision: "synthetic-revision",
      account: {
        subject: "user",
        email: "builder@example.com",
        canUseRemoteAgents: true,
        canUseBuilderlabDecisions: false,
      },
    }),
  );
  expect(await screen.findByText("builder@example.com")).toBeVisible();
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(document.body).not.toHaveTextContent("secret");
  session.dispose();
});

it("ignores navigation from a revoked contribution", async () => {
  let active = true;
  render(
    <BuilderlabSettings
      active={() => active}
      account={null}
      communities={(navigation) => (
        <ManagementHeader title="Communities" navigation={navigation} />
      )}
      agents={<p>Agent list</p>}
    />,
  );
  const user = userEvent.setup();
  active = false;
  await user.click(
    within(screen.getByRole("region", { name: "Communities" })).getByRole(
      "button",
      { name: /^Open / },
    ),
  );
  expect(screen.getByRole("heading", { name: "Builderlab" })).toBeVisible();
  active = true;
  await user.click(
    within(screen.getByRole("region", { name: "Communities" })).getByRole(
      "button",
      { name: /^Open / },
    ),
  );
  active = false;
  await user.click(screen.getByRole("button", { name: "Back to Builderlab" }));
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
    "Communities",
  );
});

it("shows request states, populated previews, empty and unavailable prompts", () => {
  const props = {
    active: () => true,
    account: null,
    communities: () => null,
    agents: null,
  };
  const view = render(
    <BuilderlabSettings
      {...props}
      summaries={{
        agents: { kind: "pending" },
        communities: { kind: "failed" },
      }}
    />,
  );
  expect(screen.getByText("…")).toBeVisible();
  expect(screen.getByText("Couldn’t load")).toBeVisible();
  expect(screen.queryByText("Set up an agent")).not.toBeInTheDocument();
  view.rerender(
    <BuilderlabSettings
      {...props}
      summaries={{
        agents: {
          kind: "filled",
          items: [
            { key: "1", label: "One", note: "Needs setup" },
            { key: "2", label: "Two" },
            { key: "3", label: "Three" },
            { key: "4", label: "Four" },
          ],
        },
        communities: { kind: "empty" },
      }}
    />,
  );
  const agents = screen.getByRole("region", { name: "Remote agents" });
  expect(within(agents).getAllByRole("listitem")).toHaveLength(3);
  expect(within(agents).getByText("One · Needs setup")).toBeVisible();
  expect(within(agents).getByText("+1 more")).toBeVisible();
  expect(within(agents).queryByText("Four")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Create a community" }),
  ).toBeVisible();
  expect(
    agents.compareDocumentPosition(
      screen.getByRole("region", { name: "Communities" }),
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  view.rerender(
    <BuilderlabSettings
      {...props}
      summaries={{
        agents: { kind: "empty" },
        communities: { kind: "empty" },
      }}
    />,
  );
  expect(screen.getByRole("button", { name: "Set up an agent" })).toBeVisible();
  expect(
    screen
      .getByRole("region", { name: "Communities" })
      .compareDocumentPosition(agents) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  view.rerender(
    <BuilderlabSettings
      {...props}
      summaries={{
        agents: { kind: "unavailable" },
        communities: { kind: "empty" },
      }}
    />,
  );
  expect(screen.getByRole("button", { name: "Learn more" })).toBeVisible();
  expect(
    within(agents).getByText("Not available for this account"),
  ).toBeVisible();
  expect(screen.queryByText("Set up an agent")).not.toBeInTheDocument();
});
