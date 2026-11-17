import type {
  SidebarContext,
  RegisteredSidebarContext,
} from "../sidebar/contracts";
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ReactElement, ReactNode } from "react";
import type { OpenTarget } from "../navigation/targets";
import { isBundledOwner } from "../../plugins/provenance";
import type {
  SidebarSectionSource,
  RegisteredSidebarSectionSource,
} from "./sidebar-section-components";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions.ts";

export type SidebarSectionRow = Readonly<{
  id: string;
  label: string;
  icon?: ReactNode;
  badge?: string;
  count?: number;
  status?: string;
}>;

export type SidebarSectionAction = Readonly<{
  id: string;
  label: string;
  icon: ReactElement;
  onSelect: () => void | Promise<void>;
}>;

export type SidebarSectionContribution = Readonly<{
  version: 1;
  id: string;
  title: string;
  icon: ReactNode;
  rows: Readonly<{
    snapshot: () => readonly SidebarSectionRow[];
    subscribe: (listener: () => void) => () => void;
  }>;
  select: (row: SidebarSectionRow) => OpenTarget;
  actions?: readonly SidebarSectionAction[];
}>;

export type RegisteredSidebarSection = Contribution<SidebarSectionContribution>;
export type SidebarSections = Readonly<{
  version: 1;
  snapshot: () => readonly RegisteredSidebarSection[];
  subscribe: (listener: () => void) => () => void;
  register: (section: SidebarSectionContribution) => void;
  registerContext?: (context: SidebarContext) => void;
  contextSnapshot?: () => readonly RegisteredSidebarContext[];
  contextSubscribe?: (listener: () => void) => () => void;
  /** Preview v2 component sources; likely to break. Absent on older hosts. */
  registerSource?: (source: SidebarSectionSource) => void;
  sourceSnapshot?: () => readonly RegisteredSidebarSectionSource[];
  sourceSubscribe?: (listener: () => void) => () => void;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Read with `ctx.reflect.get("sidebarSections")` for old-host compatibility. */
    sidebarSections?: SidebarSections;
  }
}

const idPattern = /^[a-z0-9][a-z0-9._-]*$/;

function isComponent(value: unknown) {
  return (
    typeof value === "function" ||
    (typeof value === "object" &&
      value !== null &&
      "$$typeof" in value &&
      (value.$$typeof === Symbol.for("react.memo") ||
        value.$$typeof === Symbol.for("react.forward_ref")))
  );
}

export class SidebarSectionsService extends Service implements SidebarSections {
  private readonly contributions;
  private readonly sources;
  private readonly contexts;
  readonly version = 1 as const;

  constructor(ctx: Context) {
    super(ctx, "sidebarSections");
    this.contributions = createContributions<SidebarSectionContribution>(ctx);
    this.sources = createContributions<SidebarSectionSource>(ctx);
    this.contexts = createContributions<SidebarContext>(ctx);
  }

  snapshot = () => this.contributions.snapshot();
  subscribe = (listener: () => void) => this.contributions.subscribe(listener);
  sourceSnapshot = () => this.sources.snapshot();
  sourceSubscribe = (listener: () => void) => this.sources.subscribe(listener);

  contextSnapshot = () => this.contexts.snapshot();
  contextSubscribe = (listener: () => void) =>
    this.contexts.subscribe(listener);

  registerContext(context: SidebarContext) {
    if (!this.ctx.pluginOwner || !isBundledOwner(this.ctx.pluginOwner))
      throw new Error("Sidebar contexts are available only to bundled plugins");
    if (
      !context ||
      typeof context.id !== "string" ||
      !idPattern.test(context.id) ||
      typeof context.matches !== "function" ||
      !isComponent(context.component)
    )
      throw new Error("A sidebar context needs an id, matcher and component");
    this.contexts.register(this.ctx, context);
  }

  registerSource(source: SidebarSectionSource) {
    if (!this.ctx.pluginOwner || !isBundledOwner(this.ctx.pluginOwner))
      throw new Error(
        "Sidebar v2 sources are available only to bundled plugins",
      );
    if (
      source?.version !== 2 ||
      typeof source.id !== "string" ||
      !idPattern.test(source.id) ||
      (source.scope !== undefined && typeof source.scope !== "string") ||
      typeof source.context !== "string" ||
      !source.context.trim() ||
      !isComponent(source.component)
    )
      throw new Error("A sidebar source needs a v2 id, context and component");
    this.sources.register(this.ctx, source);
  }

  register(section: SidebarSectionContribution) {
    if (section?.version !== 1) {
      console.warn("Ignoring unsupported sidebar section contribution version");
      return;
    }
    if (
      typeof section.id !== "string" ||
      !idPattern.test(section.id) ||
      typeof section.title !== "string" ||
      !section.title.trim() ||
      section.icon == null ||
      !section.rows ||
      typeof section.rows.snapshot !== "function" ||
      typeof section.rows.subscribe !== "function" ||
      typeof section.select !== "function" ||
      (section.actions !== undefined &&
        (!Array.isArray(section.actions) ||
          section.actions.some(
            (action) =>
              !action ||
              typeof action.id !== "string" ||
              !idPattern.test(action.id) ||
              typeof action.label !== "string" ||
              !action.label.trim() ||
              action.icon == null ||
              typeof action.onSelect !== "function",
          )))
    )
      throw new Error(
        "A sidebar section needs an id, title, rows, and select action",
      );
    this.contributions.register(this.ctx, section);
  }
}
