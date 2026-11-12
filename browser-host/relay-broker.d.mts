import type { Plugin } from "vite";
export function relayBrokerPlugin(options?: {
  archiveFile?: string;
  authorizedViewer?: string | undefined;
  browserOrigin?: string | undefined;
  agentLibrary?: () => Promise<
    import("../src/features/agents/library").AgentLibrary
  >;
  relayUrl?: string | undefined;
  communityAliases?: string | undefined;
  identity?: () => Uint8Array;
  authority?: (
    fetch: typeof globalThis.fetch,
    relay: string,
  ) => Promise<{ relayAuthor: string; archiveAuthority?: string }>;
  upstreamFetch?: typeof fetch;
  socketFactory?: (url: string) => WebSocket;
  builderlab?: {
    api?: string;
    appsBase?: string | undefined;
    fetch?: typeof fetch;
    open?: (url: string) => Promise<void>;
  };
}): Plugin;
export function validProductFeedback(event: {
  kind: number;
  content: string;
  created_at: number;
  tags: unknown;
}): boolean;
