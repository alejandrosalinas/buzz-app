import * as React from "react";
import { useAgentSaveState } from "../../features/agents/AgentSaveButton";
export const problem = (error: string) =>
  error && (
    <p role="alert" className="text-body-sm text-danger">
      {error}
    </p>
  );
export function useAction() {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState("");
  // Agent tabs stay open until a pending save settles, so its error shows.
  useAgentSaveState(false, pending);
  const run = async (action: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };
  const reset = () => setError("");
  return { pending, error, run, reset };
}
