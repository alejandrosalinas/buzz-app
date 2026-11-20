import type { Context } from "@deepseek-ai/cordis";
import { registerPerformanceTool } from "../../features/developer/performance-tool";

export const inject = ["agents"];

export function apply(ctx: Context) {
  const lifetime = new AbortController();
  ctx.effect(() => () => lifetime.abort());
  registerPerformanceTool(ctx.agents, lifetime.signal);
}
