// What the in-conversation card for an agent's plugin request needs to
// confirm it: the plugin manager, which installs and deletes code, and the
// open-review hold that keeps a plugin's install request from opening another
// review. Only that built-in feature may take either, so no plugin can
// install or delete plugins by asking.
import { Service, type Context } from "@deepseek-ai/cordis";
import type { PluginManager } from "./manager";

/** The built-in feature that draws the card, as `pluginOwner.id` names it. */
export const PLUGIN_REQUEST_REVIEWER = "buzz.plugin-requests";

declare module "@deepseek-ai/cordis" {
  interface Context {
    pluginManagement: PluginManagement;
    pluginReviewHold: PluginReviewHold;
  }
}
export type PluginManagement = Readonly<{ manager(): PluginManager }>;
export type PluginReviewHold = Readonly<{
  /** Refuses plugin install requests until the returned function runs. */
  hold(): () => void;
}>;

const reviewer = (ctx: Context) => {
  if (ctx.pluginOwner?.id !== PLUGIN_REQUEST_REVIEWER)
    throw new Error("Only plugin request reviews may change plugins");
};

export function providePluginManagement(
  ctx: Context,
  manager: PluginManager,
): PluginManagement {
  // A method, not an arrow property: Cordis gives it the caller's context.
  class Management extends Service implements PluginManagement {
    constructor() {
      super(ctx, "pluginManagement");
    }
    manager() {
      reviewer(this.ctx);
      return manager;
    }
  }
  return new Management();
}

export function providePluginReviewHold(
  ctx: Context,
  hold: () => () => void,
): PluginReviewHold {
  class Hold extends Service implements PluginReviewHold {
    constructor() {
      super(ctx, "pluginReviewHold");
    }
    hold() {
      reviewer(this.ctx);
      return hold();
    }
  }
  return new Hold();
}
