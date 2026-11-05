import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import type { PluginManager } from "./manager";
import {
  PLUGIN_REQUEST_REVIEWER,
  providePluginManagement,
  providePluginReviewHold,
} from "./review-access";

function setup() {
  const root = new Context();
  const manager = { name: "manager" } as unknown as PluginManager;
  const release = vi.fn();
  const hold = vi.fn(() => release);
  providePluginManagement(root, manager);
  providePluginReviewHold(root, hold);
  const as = async (id: string) => {
    let scope: Context | undefined;
    const fiber = root.extend({ pluginOwner: { id, revision: "one" } }).plugin({
      inject: ["pluginManagement", "pluginReviewHold"],
      apply: (ctx: Context) => {
        scope = ctx;
      },
    });
    await fiber.await();
    return scope as Context;
  };
  return { manager, hold, release, as };
}

it("gives the plugin manager and the review hold to the plugin request review", async () => {
  const { manager, hold, release, as } = setup();
  const ctx = await as(PLUGIN_REQUEST_REVIEWER);
  expect(ctx.pluginManagement.manager()).toBe(manager);
  expect(ctx.pluginReviewHold.hold()).toBe(release);
  expect(hold).toHaveBeenCalledOnce();
});

it("refuses every other plugin, which could otherwise install or delete plugins unreviewed", async () => {
  const { hold, as } = setup();
  const ctx = await as("example.browser");
  expect(() => ctx.pluginManagement.manager()).toThrow(
    "Only plugin request reviews may change plugins",
  );
  expect(() => ctx.pluginReviewHold.hold()).toThrow(
    "Only plugin request reviews may change plugins",
  );
  expect(hold).not.toHaveBeenCalled();
});
