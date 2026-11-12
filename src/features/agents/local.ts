/** One agent this machine keeps, in any community. Names never grant control;
 * Agents owns its key and runtime. */
export type LocalAgent = Readonly<{
  pubkey: string;
  name: string;
  /** The community origin it was created for. */
  relayUrl: string;
  owner: string;
  /** Its profile picture, an HTTPS image URL. */
  picture?: string;
  /** A managed native harness can run on a saved remote execution target. */
  execution?: "remote" | "local";
  /** Hosted runtime identity for display; it grants no local control. */
  runtime?: string;
  /** Its agent type on this machine, for host features a harness keys. */
  type?: string;
}>;
export type LocalAgentsSnapshot = Readonly<{
  status: "unavailable" | "loading" | "ready" | "error";
  agents: readonly LocalAgent[];
  /** Completed owned hosted agents shown in the selected community. No local custody. */
  hosted?: readonly LocalAgent[];
  error?: string;
}>;
export type LocalAgents = {
  snapshot(): LocalAgentsSnapshot;
  subscribe(listener: () => void): () => void;
  /** Reads the list again, as Retry asks; the producer owns the read. */
  refresh(): Promise<void>;
};

const unavailable: LocalAgentsSnapshot = Object.freeze({
  status: "unavailable",
  agents: Object.freeze([]),
});

/** Names and mentions are composed before Agents exists; this lets them
 * follow its list once `bind` connects it. */
export function createLocalAgents() {
  let source: LocalAgents | undefined;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const agents: LocalAgents = {
    snapshot: () => source?.snapshot() ?? unavailable,
    refresh: () => source?.refresh() ?? Promise.resolve(),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    agents,
    bind(next: LocalAgents) {
      source = next;
      const stop = next.subscribe(notify);
      notify();
      return () => {
        stop();
        if (source === next) source = undefined;
        notify();
      };
    },
  };
}
