// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PrimarySidebar } from "./PrimarySidebar";
import { SidebarSectionSlotView } from "../../features/channel-navigation/SidebarSectionSources";
import { SidebarFrame } from "../../features/channel-navigation/SidebarFrame";
import type { RegisteredSidebarContext } from "../../features/sidebar/contracts";
import type { SidebarSections } from "../../features/channel-navigation/sidebar-sections-service";
import type { RegisteredSidebarSectionSource } from "../../features/channel-navigation/sidebar-section-components";
import type { RegisteredPage } from "../../features/pages/service";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("replaces the default context through the page adapter and restores its slots on return", () => {
  const mounted = vi.fn();
  const unmounted = vi.fn();
  let applicable = true;
  const context: RegisteredSidebarContext = {
    id: "navigation",
    key: "example.navigation/navigation",
    pluginId: "example.navigation",
    revision: "one",
    matches: () => applicable,
    component: function DefaultContext({ Frame, renderSections }) {
      useLayoutEffect(() => {
        mounted();
        return () => unmounted();
      }, []);
      return (
        <Frame label="Navigation">
          {renderSections({
            settled: true,
            children: (slots, sources) => (
              <>
                {sources()}
                {slots.map((slot) => (
                  <SidebarSectionSlotView key={slot.key} slot={slot} />
                ))}
              </>
            ),
          })}
        </Frame>
      );
    },
  };
  const contexts = [context];
  const source: RegisteredSidebarSectionSource = {
    version: 2,
    id: "items",
    key: "example.navigation/items",
    pluginId: "example.navigation",
    revision: "one",
    context: context.key,
    component: ({ render }) =>
      render([
        {
          id: "item",
          defaultPosition: 0,
          element: <button type="button">Default item</button>,
        },
      ]),
  };
  const sources = [source];
  const empty = () => [];
  const registry: SidebarSections = {
    version: 1,
    register() {},
    snapshot: empty,
    subscribe: () => () => {},
    contextSnapshot: () => contexts,
    contextSubscribe: () => () => {},
    sourceSnapshot: () => sources,
    sourceSubscribe: () => () => {},
  };
  const pendingAtMount: boolean[] = [];
  const page: RegisteredPage = {
    id: "settings",
    key: "example.settings/settings",
    pluginId: "example.settings",
    revision: "one",
    title: "Settings example",
    component: () => null,
    sidebar: function Replacement() {
      useLayoutEffect(() => {
        pendingAtMount.push(
          !!document.querySelector('[data-buzz-launch-pending="required"]'),
        );
      }, []);
      return (
        <SidebarFrame label="Replacement">
          <button type="button">Replacement item</button>
        </SidebarFrame>
      );
    },
  };
  const pages = [page];
  const pageRegistry = { snapshot: () => pages, subscribe: () => () => {} };
  const target = { version: 1, kind: "home" } as const;
  const tree = (replace = false) => (
    <PrimarySidebar
      registry={registry}
      scope="same-workspace"
      target={target}
      replacement={replace ? { page, registry: pageRegistry } : undefined}
    >
      <span>Pages</span>
    </PrimarySidebar>
  );
  applicable = false;
  const view = render(tree());
  expect(screen.queryByRole("button", { name: "Default item" })).toBeNull();
  expect(mounted).not.toHaveBeenCalled();
  expect(
    document.querySelector('[data-buzz-launch-pending="required"]'),
  ).toBeNull();
  applicable = true;
  view.rerender(tree());
  expect(screen.getByRole("button", { name: "Default item" })).toBeVisible();
  expect(mounted).toHaveBeenCalledOnce();
  const retained = screen.getByRole("button", { name: "Default item" });
  applicable = false;
  view.rerender(tree());
  expect(screen.getByRole("button", { name: "Default item" })).toBe(retained);
  expect(unmounted).not.toHaveBeenCalled();
  applicable = true;
  view.rerender(tree(true));
  expect(
    screen.getByRole("button", { name: "Replacement item" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Default item" })).toBeNull();
  expect(unmounted).toHaveBeenCalledOnce();
  expect(mounted).toHaveBeenCalledOnce();
  expect(
    document.querySelector('[data-sidebar-slot="example.settings/settings"]'),
  ).not.toBeNull();
  expect(pendingAtMount).toEqual([true]);
  expect(
    document.querySelector('[data-buzz-launch-pending="required"]'),
  ).toBeNull();
  view.rerender(tree());
  expect(screen.getByRole("button", { name: "Default item" })).toBeVisible();
  expect(mounted).toHaveBeenCalledTimes(2);
  view.rerender(tree(true));
  expect(pendingAtMount).toEqual([true, true]);
});
