import type { ComponentType } from "react";

/** One signed-in Builderlab lifetime; never passed to website JavaScript.
 * `federated` is the public NIP-FI session revision; native holds its token. */
export type BuilderlabViewerSession = Readonly<
  ({ federated: string } | { broker: { origin: string; revision: string } }) & {
    storage: string;
    signal: AbortSignal;
  }
>;

export type BrowserViewProps = Readonly<{
  url: string;
  /** Bootstrap only the configured Builderlab tenant's app using its native viewer exchange. */
  builderlab?: BuilderlabViewerSession;
  /** Which polled destinations may reopen after guest eviction. Native auth still validates the destination. */
  canResumeUrl?: ((url: string) => boolean) | undefined;
  /** Keeps the website's cookies and storage under this name between opens
   * and restarts (1-64 of a-z, 0-9, `-`, `_`, `.`), where the platform can hold
   * them apart from Buzz's own. Without it each open is a private session. */
  storage?: string;
  /** Names the view's tab until the website has a title, and while a hidden
   * tab has not opened it yet. */
  label?: string | undefined;
}>;

export interface Browser {
  readonly available: boolean;
  readonly View: ComponentType<BrowserViewProps>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    browser: Browser;
  }
}
