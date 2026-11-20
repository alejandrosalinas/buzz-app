import { isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import type { Agents } from "../agents/service";
import { runtimePerformance } from "./runtime-performance";

/** The existing local plugin tool route also serves approved external agents. */
export function registerPerformanceTool(
  agents: Pick<Agents, "addTool" | "subscribe">,
  lifetime: AbortSignal,
) {
  agents.addTool({
    name: "performance_snapshot",
    description:
      "Sample this Buzz page for 1–10 seconds (default 5) and return bounded JSON: visible main-thread delay, client batch/read totals, agent updates and plugin MCP reply serialization. No message text. Requires this device’s Performance diagnostics plugin.",
    inputSchema: {
      type: "object",
      properties: {
        duration_ms: { type: "integer", minimum: 1000, maximum: 10000 },
      },
      additionalProperties: false,
    },
    async call(client, _context, args) {
      if (Object.keys(args).some((key) => key !== "duration_ms"))
        throw new Error("Only duration_ms is supported.");
      const report = await runtimePerformance.capture(
        args.duration_ms === undefined ? 5000 : (args.duration_ms as number),
        (changed) => agents.subscribe(changed),
        [lifetime, ...(client.signal ? [client.signal] : [])],
      );
      const desktop = isTauri();
      const appVersion = desktop ? await getVersion().catch(() => null) : null;
      return JSON.stringify({
        ...report,
        host: { desktop, production: import.meta.env.PROD, appVersion },
      });
    },
  });
}
