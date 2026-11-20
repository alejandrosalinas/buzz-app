// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AgentsContext } from "../features/agents/react";
import type { Agents } from "../features/agents/service";
import type { PluginManifest } from "../plugins/api";
import {
  PluginAccessReview,
  pluginAccessIncreases,
} from "./PluginAccessReview";

afterEach(cleanup);

const manifest = (files: boolean): PluginManifest => ({
  id: "example.files",
  name: "File reader",
  apiVersion: 1,
  host: { files },
});

it("discloses native file access in the shared installed/import review", async () => {
  render(<PluginAccessReview manifest={manifest(true)} />);
  fireEvent.click(screen.getByRole("button", { name: /Read your files/ }));
  await waitFor(() =>
    expect(
      screen.getByText(
        /Reads files and resolves folders with your account’s full access/,
      ),
    ).toBeVisible(),
  );
});

it.each([
  [false, true, "Added"],
  [true, false, "Removed"],
] as const)(
  "compares native file access from %s to %s",
  (before, after, change) => {
    render(
      <PluginAccessReview
        manifest={manifest(after)}
        previousManifest={manifest(before)}
      />,
    );
    expect(
      within(
        screen.getByRole("region", { name: `${change} declarations` }),
      ).getByRole("button", { name: /Read your files/ }),
    ).toBeVisible();
  },
);

it("keeps unchanged native file access in the unchanged view", () => {
  const { rerender } = render(
    <PluginAccessReview
      manifest={manifest(true)}
      previousManifest={manifest(true)}
    />,
  );
  expect(screen.getByText("No declared access changes")).toBeVisible();
  expect(screen.queryByRole("button", { name: /Read your files/ })).toBeNull();
  expect(
    screen.getByRole("button", { name: "View unchanged declarations" }),
  ).toBeVisible();
  rerender(
    <PluginAccessReview
      manifest={manifest(true)}
      previousManifest={manifest(true)}
      unchangedOnly
    />,
  );
  expect(screen.getByRole("button", { name: /Read your files/ })).toBeVisible();
});

it.each([
  ["agentHooks", /Observe and influence buzz.pi\/pi/],
  ["agentExecution", /Run buzz.pi\/pi on another host/],
] as const)(
  "discloses %s access as a new permission for each harness",
  (grant, label) => {
    render(
      <PluginAccessReview
        manifest={{
          id: "policy",
          name: "Policy",
          apiVersion: 1,
          host: { [grant]: ["buzz.pi/pi"] },
        }}
        previousManifest={{ id: "policy", name: "Policy", apiVersion: 1 }}
      />,
    );
    expect(
      within(
        screen.getByRole("region", { name: "Added declarations" }),
      ).getByRole("button", { name: label }),
    ).toBeVisible();
  },
);

const replaces = (...agentPromptSections: string[]): PluginManifest => ({
  id: "example.worktrees",
  name: "Worktrees",
  apiVersion: 1,
  host: { agentPromptSections },
});
it("discloses each base instruction section a plugin can replace, by its title", async () => {
  render(
    <PluginAccessReview manifest={replaces("working-location", "progress")} />,
  );
  expect(
    screen.getByRole("button", {
      name: /Replace the Progress instructions for agents/,
    }),
  ).toHaveTextContent(
    "Can replace this part of the base instructions in chats it manages.",
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: /Replace the Working location instructions for agents/,
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByText(
        /agents get the plugin’s text for Working location in place of the text Buzz gives them/,
      ),
    ).toBeVisible(),
  );
  // An older Codex chat cannot be told what changed, so the owner is told
  // before the plugin starts it over.
  expect(
    screen.getByText(/Codex chat that an earlier Buzz version started/),
  ).toHaveTextContent("starts over once, without its earlier context");
  // Only a section the owner can set has an owner's choice to keep.
  const own = /Your own choice for this part in Settings/;
  expect(screen.queryByText(own)).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", {
      name: /Replace the Progress instructions for agents/,
    }),
  );
  await waitFor(() => expect(screen.getByText(own)).toBeVisible());
});

it("needs a review for an update that adds a section, not for one that drops one", () => {
  const one = replaces("working-location");
  const two = replaces("working-location", "progress");
  expect(pluginAccessIncreases(two, one)).toBe(true);
  expect(pluginAccessIncreases(one, two)).toBe(false);
  expect(pluginAccessIncreases(two, two)).toBe(false);
  render(<PluginAccessReview manifest={two} previousManifest={one} />);
  expect(
    within(
      screen.getByRole("region", { name: "Added declarations" }),
    ).getByRole("button", {
      name: /Replace the Progress instructions for agents/,
    }),
  ).toBeVisible();
});

it("shows a registered harness title while keeping its exact key in details", async () => {
  const types = [{ key: "third/custom", title: "Custom Agent" }];
  const agents = {
    subscribe: () => () => {},
    types: () => types,
  } as unknown as Agents;
  render(
    <AgentsContext value={agents}>
      <PluginAccessReview
        manifest={{
          id: "policy",
          name: "Policy",
          apiVersion: 1,
          host: { agentHooks: ["third/custom"] },
        }}
      />
    </AgentsContext>,
  );
  const trigger = screen.getByRole("button", {
    name: /Observe and influence Custom Agent/,
  });
  expect(trigger).not.toHaveTextContent("third/custom");
  fireEvent.click(trigger);
  await waitFor(() => expect(screen.getByText("third/custom")).toBeVisible());
});

const managed = (managedFiles: boolean): PluginManifest => ({
  ...manifest(false),
  host: { managedFiles },
});
it("discloses managed save limits and retention without implying file-reading authority", async () => {
  render(<PluginAccessReview manifest={managed(true)} />);
  expect(screen.queryByRole("button", { name: /Read your files/ })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: /Save temporary plugin files/ }),
  );
  await waitFor(() =>
    expect(
      screen.getByText(/Shared storage is limited to 64 MiB and 16 files/),
    ).toBeVisible(),
  );
  expect(
    screen.getByText(
      /This does not grant file reading or arbitrary-path writes/,
    ),
  ).toBeVisible();
});
it.each([
  [false, true, "Added"],
  [true, false, "Removed"],
] as const)(
  "compares managed save access from %s to %s",
  (before, after, change) => {
    render(
      <PluginAccessReview
        manifest={managed(after)}
        previousManifest={managed(before)}
      />,
    );
    expect(
      within(
        screen.getByRole("region", { name: `${change} declarations` }),
      ).getByRole("button", { name: /Save temporary plugin files/ }),
    ).toBeVisible();
  },
);
it("uses the existing unchanged disclosure for managed saves", () => {
  const { rerender } = render(
    <PluginAccessReview
      manifest={managed(true)}
      previousManifest={managed(true)}
    />,
  );
  expect(screen.getByText("No declared access changes")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /Save temporary plugin files/ }),
  ).toBeNull();
  rerender(
    <PluginAccessReview
      manifest={managed(true)}
      previousManifest={managed(true)}
      unchangedOnly
    />,
  );
  expect(
    screen.getByRole("button", { name: /Save temporary plugin files/ }),
  ).toBeVisible();
});

const publicImages = (granted: boolean): PluginManifest => ({
  ...manifest(false),
  host: { publicImages: granted },
});
it("discloses public image reads, their limits and that sites see the IP address", async () => {
  render(<PluginAccessReview manifest={publicImages(true)} />);
  expect(screen.queryByRole("button", { name: /Read your files/ })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", {
      name: /Contact any public website for images/,
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByText(
        /Only PNG, JPEG, GIF, WebP and AVIF images are returned/,
      ),
    ).toBeVisible(),
  );
  expect(screen.getByText(/Sites see your IP address/)).toBeVisible();
  expect(
    screen.getByText(
      /can't recognize internal sites that resolve to public addresses/,
    ),
  ).toBeVisible();
});
it("shows no public image access when it isn't declared", () => {
  render(<PluginAccessReview manifest={publicImages(false)} />);
  expect(
    screen.queryByRole("button", {
      name: /Contact any public website for images/,
    }),
  ).toBeNull();
});
const publicPages = (granted: boolean): PluginManifest => ({
  ...manifest(false),
  host: { publicPages: granted },
});
it("discloses public page reads and that only preview fields come back", async () => {
  render(<PluginAccessReview manifest={publicPages(true)} />);
  fireEvent.click(
    screen.getByRole("button", {
      name: /Contact any public website for link previews/,
    }),
  );
  await waitFor(() =>
    expect(screen.getByText(/returns only its preview fields/)).toBeVisible(),
  );
});
it("shows no public page access when it isn't declared", () => {
  render(<PluginAccessReview manifest={publicPages(false)} />);
  expect(
    screen.queryByRole("button", {
      name: /Contact any public website for link previews/,
    }),
  ).toBeNull();
});
it.each([
  [false, true, "Added"],
  [true, false, "Removed"],
] as const)(
  "compares public image access from %s to %s",
  (before, after, change) => {
    render(
      <PluginAccessReview
        manifest={publicImages(after)}
        previousManifest={publicImages(before)}
      />,
    );
    expect(
      within(
        screen.getByRole("region", { name: `${change} declarations` }),
      ).getByRole("button", { name: /Contact any public website for images/ }),
    ).toBeVisible();
  },
);
