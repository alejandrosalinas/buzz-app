import type { Agent, RegisteredAgentType } from "./service";

export type AgentExecutionLocation = "remote" | "local";

/** Short location copy for message byline tooltips, using confirmed execution. */
export function remoteExecutionDetail(
  execution: AgentExecutionLocation | undefined,
  runtime?: string,
) {
  if (execution !== "remote") return undefined;
  return runtime === "block.builderlab/builderlab"
    ? "Runs remotely on Builderlab"
    : "Runs on a remote machine";
}

/** Active fallback when current work has no step details. */
export function remoteWorkDetail(
  execution: AgentExecutionLocation | undefined,
  runtime?: string,
) {
  if (execution !== "remote") return undefined;
  return runtime === "block.builderlab/builderlab"
    ? "Running remotely on Builderlab…"
    : "Running on a remote machine…";
}

/** Execution location is independent of presence, model and ownership. */
export const executionCopy = {
  remote: {
    description:
      "Keeps working while this computer is off, and you can chat from your phone. It can’t open files on this computer.",
  },
} as const;

/** An unavailable type on another device does not establish its location. */
export function agentExecution(
  agent: Pick<Agent, "place" | "executionBinding">,
  type?: Pick<RegisteredAgentType, "remote">,
): AgentExecutionLocation | undefined {
  if (agent.executionBinding || agent.place === "hosted") return "remote";
  if (agent.place === "here" || (type && !type.remote)) return "local";
  return undefined;
}
