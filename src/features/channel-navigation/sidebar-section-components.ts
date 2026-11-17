import {
  isValidElement,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import type { Contribution } from "../../plugins/contributions";
import type { OpenTarget } from "../navigation/targets";

/** Preview, likely to break. Elements must use stable component types. */
export type SidebarComponentSection = Readonly<{
  id: string;
  title?: string | undefined;
  /** Finite ascending rank; equal ranks use the full plugin/section id. */
  defaultPosition: number;
  element: ReactElement;
}>;

/** Neutral props shared by sources in the active sidebar context. */
export type SidebarSectionEnvironment = Readonly<{
  active(): boolean;
  target: OpenTarget;
}>;

/** Preview, likely to break. One mounted source can contribute many live slots. */
export type SidebarSectionSource = Readonly<{
  version: 2;
  id: string;
  context: string;
  scope?: string | undefined;
  component: ComponentType<
    SidebarSectionEnvironment & {
      render(sections: readonly SidebarComponentSection[]): ReactNode;
    }
  >;
}>;
export type RegisteredSidebarSectionSource = Contribution<SidebarSectionSource>;

export type SidebarSectionSlot = Omit<SidebarComponentSection, "element"> & {
  key: string;
  source: RegisteredSidebarSectionSource;
  scope?: string | undefined;
  unavailable?: boolean | undefined;
};

/** Slot identity is independent of saved collapse, sort, filter and drag keys. */
export function sidebarSectionSlots(
  source: RegisteredSidebarSectionSource,
  sections: readonly SidebarComponentSection[],
): readonly (SidebarSectionSlot & Pick<SidebarComponentSection, "element">)[] {
  const ids = new Set<string>();
  return sections.flatMap((section) => {
    if (
      !section ||
      typeof section.id !== "string" ||
      !section.id.trim() ||
      ids.has(section.id) ||
      !Number.isFinite(section.defaultPosition) ||
      !isValidElement(section.element)
    ) {
      warnOnce(source, "Ignoring invalid or duplicate sidebar slot");
      return [];
    }
    ids.add(section.id);
    return [
      {
        ...section,
        key: `${source.pluginId}/${section.id}`,
        source,
        scope: source.scope,
      },
    ];
  });
}

const warned = new WeakSet<object>();
function warnOnce(source: object, message: string) {
  if (warned.has(source)) return;
  warned.add(source);
  console.warn(message);
}

export function orderSidebarSectionSlots<
  T extends { key: string; defaultPosition: number; source: object },
>(slots: readonly T[]): T[] {
  const ids = new Set<string>();
  const unique = slots.filter((slot) => {
    if (ids.has(slot.key)) {
      warnOnce(slot.source, "Ignoring duplicate sidebar slot");
      return false;
    }
    ids.add(slot.key);
    return true;
  });
  return unique.sort(
    (a, b) =>
      a.defaultPosition - b.defaultPosition ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}
