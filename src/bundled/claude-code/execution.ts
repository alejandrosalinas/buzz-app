import type { AgentExecution } from "../../features/agents/execution";
import { MIN_VERSION } from "./setup";
import type { Spawn } from "./claude";
import relay from "./execution-relay.mjs?raw";

/** Claude carries tools and hooks on its stream protocol. */
export const executionSpawn =
  (execution: AgentExecution): Spawn =>
  async (id, options) => {
    if (id !== "claude" || options?.protection || options?.mcp)
      throw new Error(`Unsupported remote Claude step ${id}`);
    execution.signal.throwIfAborted();
    return execution.spawn("node", {
      cwd: execution.workspace,
      args: [
        "--input-type=module",
        "-e",
        `const CLAUDE_MIN_VERSION=${JSON.stringify(MIN_VERSION)};\nconst CLAUDE_ARGS=${JSON.stringify(options?.args ?? [])};\n${relay}`,
      ],
      ...(options?.onStdout ? { onStdout: options.onStdout } : {}),
      ...(options?.onStderr ? { onStderr: options.onStderr } : {}),
    });
  };
