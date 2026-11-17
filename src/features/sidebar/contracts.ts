import type { ComponentProps, ComponentType, ReactNode } from "react";
import {
  resolveMatch,
  type Contribution,
  type MatchOrder,
} from "../../plugins/contributions";
import type { OpenTarget } from "../navigation/targets";
import type { SidebarFrame } from "../channel-navigation/SidebarFrame";
import type { SidebarSectionSources } from "../channel-navigation/SidebarSectionSources";

export type SidebarContextProps = {
  target: OpenTarget;
  children?: ReactNode;
  creationAction?: ReactNode;
  Frame: ComponentType<
    ComponentProps<typeof SidebarFrame> & {
      resizable?: boolean;
      scope?: string;
    }
  >;
  renderSections(
    props: Pick<
      ComponentProps<typeof SidebarSectionSources>,
      "children" | "onReady" | "settled"
    >,
  ): ReactNode;
};

/** Bundled preview: contexts supply content; the host supplies the surface and slots. */
export type SidebarContext = {
  id: string;
  page?: string;
  matches(target: OpenTarget): boolean;
  order?: MatchOrder<OpenTarget>;
  component: ComponentType<SidebarContextProps>;
};
export type RegisteredSidebarContext = Contribution<SidebarContext>;

export function resolveSidebarContext(
  contexts: readonly RegisteredSidebarContext[],
  target: OpenTarget,
  page?: string,
) {
  return resolveMatch(
    contexts.filter(
      (context) => context.page === undefined || context.page === page,
    ),
    target,
  );
}
