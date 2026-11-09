// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationService } from "../features/conversation/service";
import { MessageRow } from "../features/messages/MessageRow";
import { foldMessages } from "../features/relay/fold";
import { keypair, signed } from "../features/relay/testing";
import {
  createPluginInstallCore,
  createPluginInstallRequests,
  createPluginInstallerService,
} from "../plugins/installer";
import { createPluginManager } from "../plugins/manager";
import { PLUGIN_REQUEST_REVIEWER } from "../plugins/review-access";
import * as feature from "./plugin-request-feature";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  cleanup();
  for (const dispose of cleanups.splice(0)) await dispose();
  localStorage.removeItem("buzzodz.plugins.v1");
  vi.restoreAllMocks();
});

// The manifest of https://github.com/example-org/buzz-plugin-browser, installed
// but off, so an agent asks to enable it.
const browser = {
  id: "example.browser",
  name: "Browser",
  apiVersion: 1 as const,
  description: "Open HTTP(S) links in Buzz's side panel.",
};
const agentKey = keypair();
const reason = "Open the staging site you linked";

async function mount() {
  const ctx = new Context();
  ctx.provide("relay", { snapshot: () => ({ status: "idle" }) });
  const plugins = createPluginManager(ctx, {
    bundled: [
      {
        manifest: browser,
        module: { apply() {} },
        enabledByDefault: false,
      },
    ],
    builtIn: [
      {
        manifest: {
          id: PLUGIN_REQUEST_REVIEWER,
          name: "Plugin requests",
          apiVersion: 1,
        },
        module: feature,
      },
    ],
  });
  const installRequests = createPluginInstallRequests();
  createPluginInstallerService(ctx, {
    core: createPluginInstallCore({
      plugins,
      requests: installRequests,
      openPlugins: async () => ({ status: "opened" }),
    }),
  });
  const service = new ConversationService(ctx);
  cleanups.push(async () => {
    await plugins.dispose();
    await ctx.fiber.dispose();
  });
  await waitFor(() =>
    expect(plugins.snapshot().configuration.status).toBe("ready"),
  );
  const agent = plugins.requests.forAgent({
    pubkey: agentKey.pubkey,
    name: "Builder",
  });
  const { requestId } = await agent.request({
    action: "enable",
    id: browser.id,
    reason,
  });
  const [row] = foldMessages("chan", "relay", [
    signed(agentKey, {
      kind: 9,
      content: `Requested: enable Browser — ${reason}`,
      tags: [
        ["h", "chan"],
        ["plugin-request", requestId],
      ],
    }),
  ]);
  if (!row) throw new Error("No message");
  render(
    <MessageRow
      row={row}
      extensions={service}
      day={false}
      retry={undefined}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
    />,
  );
  return { plugins, agent, requestId, installRequests };
}

it("draws the request in its message and applies the change the owner confirms there", async () => {
  const { plugins, agent, requestId, installRequests } = await mount();
  const card = await screen.findByRole("region", {
    name: "Plugin request: Browser",
  });
  expect(within(card).getByText(`Builder: ${reason}`)).toBeVisible();
  fireEvent.click(within(card).getByRole("button", { name: "Review Browser" }));
  const dialog = await screen.findByRole("dialog", { name: "Enable Browser?" });
  // A plugin's own install request cannot open a second review over this one.
  const source = {
    repository: "https://github.com/example-org/buzz-plugin-browser",
    reference: "main",
  };
  await expect(
    installRequests.request(source, { id: "other", name: "Other" }),
  ).resolves.toBe("unavailable");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Enable plugin" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await screen.findByRole("status")).toHaveTextContent("Enabled");
  const { configuration } = plugins.snapshot();
  expect(
    configuration.status === "ready" &&
      configuration.catalog.plugins.find(
        (item) => item.manifest.id === browser.id,
      )?.enabled,
  ).toBe(true);
  expect(agent.status(requestId).state).toBe("approved");
  const waiting = installRequests.request(source, { id: "o", name: "O" });
  expect(installRequests.snapshot()).toBeDefined();
  installRequests.settle(installRequests.snapshot()?.id ?? 0, "cancelled");
  await waiting;
});
