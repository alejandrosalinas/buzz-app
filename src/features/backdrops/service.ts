// Plugin-painted layers behind the app shell. The shell has none by default.
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ComponentType } from "react";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";

/** A decorative layer above the shell's own background and below all of its
 * content. The plugin owns what it paints there; the host owns placement. */
export type Backdrop = Readonly<{ id: string; component: ComponentType }>;
export type RegisteredBackdrop = Contribution<Backdrop>;
export type Backdrops = Readonly<{
  snapshot(): readonly RegisteredBackdrop[];
  subscribe(listener: () => void): () => void;
  register(backdrop: Backdrop): void;
}>;
declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Read with `ctx.reflect.get("backdrops")` for old-host compatibility. */
    backdrops?: Backdrops;
  }
}

export class BackdropsService extends Service implements Backdrops {
  private readonly contributions;
  constructor(ctx: Context) {
    super(ctx, "backdrops");
    this.contributions = createContributions<Backdrop>(ctx);
  }
  snapshot = () => this.contributions.snapshot();
  subscribe = (listener: () => void) => this.contributions.subscribe(listener);
  register(backdrop: Backdrop) {
    if (
      !backdrop ||
      typeof backdrop.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(backdrop.id) ||
      typeof backdrop.component !== "function"
    )
      throw new Error("A backdrop needs an id and a React component function");
    this.contributions.register(this.ctx, backdrop);
  }
}
