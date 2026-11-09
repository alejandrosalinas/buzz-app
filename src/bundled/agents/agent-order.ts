import { useCallback, useState, useSyncExternalStore } from "react";
import type { Agent } from "../../features/agents/service";
import {
  readView,
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";

const KEY = "agents:order";

/** Display order only: never changes the agent service, teams or main agent. */
export function useAgentOrder(
  scope: string | undefined,
  agents: readonly Agent[],
) {
  useSyncExternalStore(
    useCallback(
      (notify) => (scope ? subscribeView(scope, notify) : () => {}),
      [scope],
    ),
    () => (scope ? viewRevision(scope, KEY) : null),
  );
  const [error, setError] = useState("");
  const saved = scope ? readView<unknown>(scope, KEY, []) : [];
  const savedKeys = [
    ...new Set(
      (Array.isArray(saved) ? saved : []).filter(
        (key): key is string =>
          typeof key === "string" && /^[0-9a-f]{64}$/.test(key),
      ),
    ),
  ];
  const ranks = new Map(savedKeys.map((key, index) => [key, index]));
  const ordered = [...agents].sort(
    (a, b) =>
      (ranks.get(a.pubkey) ?? Infinity) - (ranks.get(b.pubkey) ?? Infinity),
  );
  const save = (next: readonly Agent[]) => {
    const keys = next.map((agent) => agent.pubkey);
    const visible = new Set(keys);
    let index = 0;
    // An incomplete inventory is not deletion evidence. Replace only visible
    // slots, retain absent saved keys, then append any newly seen agents.
    const merged = savedKeys.map((key) =>
      visible.has(key) ? keys[index++] : key,
    );
    merged.push(...keys.slice(index));
    const saved = !!scope && writeView(scope, KEY, merged);
    setError(
      saved
        ? ""
        : "The agent order couldn't be saved on this device. Try again.",
    );
    return saved;
  };
  return { ordered, save, error };
}

export function moveAgent(agents: readonly Agent[], from: number, to: number) {
  const next = [...agents];
  const [agent] = next.splice(from, 1);
  if (agent) next.splice(to, 0, agent);
  return next;
}
