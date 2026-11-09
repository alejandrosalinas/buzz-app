// FOUNDATION: Page contribution contract, shared by bundled and external plugins.
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ComponentType, ReactNode } from "react";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions.ts";

export type PageProps = {
  companion?: ReactNode | undefined;
  /** Opaque identity for the current shell-owned companion opening. */
  companionOpening?: object | undefined;
  navigation?: import("../navigation/service").PageNavigation | undefined;
};

/** Props for a page-owned replacement in the shell's sidebar slot. */
export type PageSidebarProps = {
  target: import("../navigation/targets").OpenTarget;
  /** Shell-generated primary Pages navigation, when available. */
  children?: ReactNode | undefined;
};

/** Props for a primary page's navigation hover preview. */
export type PagePreviewProps = {
  /** Close the preview, for example after its content opened something. */
  close(): void;
};

export type Page = Readonly<{
  id: string;
  title: string;
  component: ComponentType<PageProps>;
  /** Replace the conversation sidebar while this page is selected. */
  sidebar?: ComponentType<PageSidebarProps>;
  layout?: "document" | "workspace";
  // Opt in only when every page state places the supplied companion card.
  companion?: boolean;
  /** Opt in to versioned page routes. Validation is synchronous and side-effect-free. */
  route?: Readonly<{
    version: number;
    validate(params: import("../navigation/targets").JsonValue): boolean;
  }>;
  /** This page acknowledges its own domain reveal rather than just successful mounting. */
  handlesNavigation?: boolean;
  /**
   * Opt in to the shell's page navigation. Every active page stays
   * listed in search and reachable by deep link or from another page.
   */
  primary?: boolean;
  /** Preferred navigation location for a primary page: a row in the Messages
   * sidebar (the default) or an app in the dock. `topbar` and `toolbar` are
   * pre-dock aliases for `dock`, still accepted.
   */
  placement?: "sidebar" | "dock" | "topbar" | "toolbar";
  /**
   * A `data:image/<subtype>[;params],<payload>` URL shown beside the page in
   * search and primary navigation. Any other value is dropped with a warning,
   * and a missing or unloadable image shows the generic page icon. Bundled
   * pages keep their host icons.
   */
  icon?: string;
  /** Plugin-owned navigation count or mark. Toolbar icons constrain this to a
   * compact corner badge; prefer a short count or dot there.
   */
  badge?: ComponentType;
  /**
   * Supplemental content the shell shows while a pointer rests on this page's
   * sidebar or app-dock entry. It is never shown without hover or while the
   * page is selected, so the page must stay complete without it.
   */
  preview?: ComponentType<PagePreviewProps>;
}>;
export type RegisteredPage = Contribution<Page>;
export type PagesReader = {
  snapshot: () => readonly RegisteredPage[];
  subscribe: (listener: () => void) => () => void;
};
export type Pages = PagesReader & { register(page: Page): void };
declare module "@deepseek-ai/cordis" {
  interface Context {
    pages: Pages;
  }
}

const dataImageUrl = /^data:image\/[\w.+-]+(?:;[^,]*)?,/i;

export class PagesService extends Service implements Pages {
  private readonly contributions;
  constructor(ctx: Context) {
    super(ctx, "pages");
    this.contributions = createContributions<Page>(ctx);
  }
  snapshot = () => this.contributions.snapshot();
  subscribe = (listener: () => void) => this.contributions.subscribe(listener);
  register(page: Page) {
    if (
      !page ||
      typeof page.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(page.id) ||
      typeof page.title !== "string" ||
      !page.title.trim() ||
      typeof page.component !== "function" ||
      (page.sidebar !== undefined && typeof page.sidebar !== "function") ||
      (page.layout !== undefined &&
        page.layout !== "document" &&
        page.layout !== "workspace") ||
      (page.companion !== undefined && typeof page.companion !== "boolean") ||
      (page.primary !== undefined && typeof page.primary !== "boolean") ||
      (page.badge !== undefined && typeof page.badge !== "function") ||
      (page.preview !== undefined && typeof page.preview !== "function")
    ) {
      throw new Error(
        "A page needs an id, a title, and a React component function",
      );
    }
    if (
      page.route &&
      (!Number.isSafeInteger(page.route.version) ||
        page.route.version < 1 ||
        typeof page.route.validate !== "function")
    )
      throw new Error("Invalid page route contract");
    this.contributions.register(
      this.ctx,
      this.withAcceptedPlacement(this.withAcceptedIcon(page)),
    );
  }
  private withAcceptedPlacement(page: Page): Page {
    const { placement, ...rest } = page;
    if (
      placement === undefined ||
      placement === "sidebar" ||
      placement === "dock" ||
      placement === "topbar" ||
      placement === "toolbar"
    )
      return page;
    console.warn(
      `Ignoring page placement for ${this.ctx.pluginOwner?.id}/${page.id}: expected sidebar or dock`,
    );
    return rest;
  }
  // A rejected icon is decoration, so it must not fail plugin activation.
  private withAcceptedIcon(page: Page): Page {
    const { icon, ...rest } = page;
    if (
      icon === undefined ||
      (typeof icon === "string" && dataImageUrl.test(icon))
    )
      return page;
    console.warn(
      `Ignoring page icon for ${this.ctx.pluginOwner?.id}/${page.id}: expected a data:image/ URL`,
    );
    return rest;
  }
}
