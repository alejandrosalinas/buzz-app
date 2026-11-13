// FOUNDATION: Target-based panel contributions, independent of page layout.
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ComponentType } from "react";
import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import {
  createContributions,
  resolveMatch,
  type Contribution,
  type MatchOrder,
} from "../../plugins/contributions";

export type PanelContext = Readonly<{
  /** Originating conversation, not a claim of thread-level scope or access. */
  channelId: string;
  /** Thread root of the message the panel was opened from, when there is one. */
  rootId?: string;
  canOpen(target: string): boolean;
  /**
   * Open a target through the host. A tab replaces itself; a channel drawer or
   * side column opens the target as a tab. False after this opening is retired.
   */
  open(target: string): boolean;
  /** Drill into a child while the channel host retains the previous view. */
  push?(target: string): boolean;
}>;
/** Public presentation context, not authentication or a live selection service. */
export type ChannelPanelContext = Readonly<{
  scope: string;
  channelId: string;
  channelName: string;
  viewer: string;
  relayUrl: string;
  threadId?: string;
}>;
export type ChannelLauncherProps = {
  context: ChannelPanelContext;
  pressed: boolean;
  /** Open the current conversation’s host-owned member picker. */
  openMembers?: (() => void) | undefined;
  /** Toggles this exact contribution in the page-owned channel panel. */
  toggle(target: string): void;
  /** False after this page binding or exact contribution is retired. */
  available(): boolean;
  /** Presentation only; the page re-resolves targets when opening. */
  canOpen(target: string): boolean;
  /** Open another target, such as a panel URL, as a tab in this channel.
   * False after this page binding or exact contribution is retired. */
  open(target: string): boolean;
};
export type PanelProps = {
  /** Supplied only by a channel presentation; sessions decide when to capture it. */
  channelContext?: ChannelPanelContext | undefined;
  close(): void;
  target: string;
  context?: PanelContext | undefined;
};
export type Panel = Readonly<{
  id: string;
  title: string;
  matches: (url: string) => boolean;
  /** Claim strength when several panels match a target; see `MatchOrder`. */
  order?: MatchOrder | undefined;
  // Optional host launcher; placement stays with the current page or host fallback.
  launcher?: Readonly<{ icon: string; target: string }>;
  /** Optional live controls beside shell search; lifetime remains plugin-owned. */
  toolbar?: ComponentType;
  // Optional channel-header launcher. The page supplies context and owns placement.
  channelLauncher?: ComponentType<ChannelLauncherProps>;
  /** Optional Channels menu placement; eligibility is presentation-only, not access. */
  channelMenu?: Readonly<{
    label: string;
    eligible(channel: ChannelSummary, session: RelaySession): boolean;
  }>;
  /**
   * Channel launchers default to the bottom drawer; side reuses the companion
   * column; tab opens a tab in the channel's side pane beside its threads.
   */
  channelPlacement?: "bottom" | "side" | "tab";
  /** Tabs opened from links stay until closed, like a channel tool's, instead
   * of giving way to the next link or thread. */
  keepOpen?: boolean;
  /** Opt into conversation detail addresses and Back/Forward/Close behavior. */
  addressable?: true;
  /** Mount tab content on first selection, then retain it for the workspace visit.
   * Component-provided titles and local detail tabs are also deferred. */
  deferUntilShown?: boolean;
  component: ComponentType<PanelProps>;
}>;
export type RegisteredPanel = Contribution<Panel>;
export type PanelOpening = {
  channelId: string;
  /** Thread root of the message the opening link was in. */
  rootId?: string;
  panel: RegisteredPanel;
  target: string;
  channelContext?: ChannelPanelContext;
};
/** The panel a link opens, kept in the thread it was opened from. */
export const panelOpening = (
  panels: Pick<Panels, "resolve">,
  channelId: string,
  target: string,
  rootId?: string,
): PanelOpening | undefined => {
  const panel = panels.resolve(target);
  return panel && { channelId, ...(rootId && { rootId }), panel, target };
};
/** A target to open beside a conversation, as if the viewer clicked a link
 * to it there. */
export type PanelOpenRequest = Readonly<{
  target: string;
  channelId: string;
  /** The thread it is opened from, absent at the channel's top level. */
  rootId?: string;
}>;
export type Panels = {
  register(panel: Panel): void;
  resolve(target: string): RegisteredPanel | undefined;
  snapshot(): readonly RegisteredPanel[];
  subscribe(listener: () => void): () => void;
  /** Opens `request.target` beside its conversation if a page shows that
   * channel now; false when none does or no panel handles the target. */
  requestOpen(request: PanelOpenRequest): boolean;
  /** A page showing conversations answers open requests while it does. */
  handleOpenRequests(
    handler: (request: PanelOpenRequest) => boolean,
  ): () => void;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    panels: Panels;
  }
}
export class PanelsService extends Service implements Panels {
  private readonly panels;
  constructor(ctx: Context) {
    super(ctx, "panels");
    this.panels = createContributions<Panel>(ctx);
  }
  private readonly openHandlers = new Set<
    (request: PanelOpenRequest) => boolean
  >();
  snapshot = () => this.panels.snapshot();
  subscribe = (listener: () => void) => this.panels.subscribe(listener);
  requestOpen = (request: PanelOpenRequest) => {
    if (!this.resolve(request.target)) return false;
    for (const handler of this.openHandlers) if (handler(request)) return true;
    return false;
  };
  handleOpenRequests = (handler: (request: PanelOpenRequest) => boolean) => {
    this.openHandlers.add(handler);
    return () => {
      this.openHandlers.delete(handler);
    };
  };
  resolve = (target: string) => resolveMatch(this.panels.snapshot(), target);
  register(panel: Panel) {
    if (
      !panel ||
      typeof panel.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(panel.id) ||
      typeof panel.title !== "string" ||
      !panel.title.trim() ||
      typeof panel.matches !== "function" ||
      typeof panel.component !== "function"
    ) {
      throw new Error("A panel needs an id, title, matcher, and component");
    }
    if (
      panel.order !== undefined &&
      typeof panel.order !== "number" &&
      typeof panel.order !== "function"
    )
      throw new Error("A panel order must be a number or function");
    if (
      panel.launcher !== undefined &&
      (!panel.launcher ||
        typeof panel.launcher.icon !== "string" ||
        !panel.launcher.icon.trim() ||
        typeof panel.launcher.target !== "string")
    ) {
      throw new Error("A panel launcher needs an icon and target string");
    }
    if (panel.toolbar !== undefined && typeof panel.toolbar !== "function")
      throw new Error("A panel toolbar needs a component");
    if (
      panel.channelLauncher !== undefined &&
      typeof panel.channelLauncher !== "function"
    )
      throw new Error("A channel launcher needs a component");
    if (
      panel.channelMenu !== undefined &&
      (!panel.channelMenu ||
        typeof panel.channelMenu.label !== "string" ||
        !panel.channelMenu.label.trim() ||
        typeof panel.channelMenu.eligible !== "function")
    )
      throw new Error(
        "A channel menu launcher needs a label and eligibility predicate",
      );
    if (
      panel.channelPlacement !== undefined &&
      panel.channelPlacement !== "bottom" &&
      panel.channelPlacement !== "side" &&
      panel.channelPlacement !== "tab"
    )
      throw new Error("A channel placement must be bottom, side or tab");
    if (panel.keepOpen !== undefined && typeof panel.keepOpen !== "boolean")
      throw new Error("A panel's keepOpen must be a boolean");
    if (panel.addressable !== undefined && panel.addressable !== true)
      throw new Error("A panel's addressable must be true when set");
    if (
      panel.deferUntilShown !== undefined &&
      typeof panel.deferUntilShown !== "boolean"
    )
      throw new Error("A panel's deferUntilShown must be a boolean");
    this.panels.register(this.ctx, {
      ...panel,
      ...(panel.launcher && { launcher: Object.freeze({ ...panel.launcher }) }),
      ...(panel.channelMenu && {
        channelMenu: Object.freeze({ ...panel.channelMenu }),
      }),
    });
  }
}
