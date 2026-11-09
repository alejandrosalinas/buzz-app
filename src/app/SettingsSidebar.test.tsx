// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsSidebar } from "./SettingsSidebar";
import type { Communities } from "../features/communities/service";
import type { SettingsCards } from "../features/settings/service";
import {
  CopyIcon,
  FolderSimpleIcon,
  GlobeIcon,
} from "../shared/design-system/icons";

import { CpuIcon, ChatCircleIcon } from "../shared/design-system/icons";

afterEach(cleanup);

// The shared sidebar's resize handle measures its panel.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

it("keeps Community admin separate and uses each card's navigation icon", () => {
  const client = {
    selected: "primary",
    memberships: [{ id: "primary", name: "Primary" }],
  };
  const connection = { scope: "settings-sidebar-admin-test" };
  const cards: ReturnType<SettingsCards["snapshot"]> = [
    {
      id: "membership",
      key: "moderation/membership",
      pluginId: "moderation",
      revision: "one",
      title: "Membership",
      icon: CopyIcon,
      section: "administration",
      component: () => null,
    },
    {
      id: "groups",
      key: "channels/groups",
      pluginId: "channels",
      revision: "one",
      title: "Personal groups",
      icon: FolderSimpleIcon,
      component: () => null,
    },
    {
      id: "hosted",
      key: "communities/hosted",
      pluginId: "communities",
      revision: "one",
      title: "Hosted communities",
      group: "Communities",
      icon: GlobeIcon,
      component: () => null,
    },
  ];
  render(
    <nav aria-label="Settings sections">
      <SettingsSidebar
        communities={
          {
            subscribe: () => () => {},
            snapshot: () => client,
            relay: {
              subscribe: () => () => {},
              snapshot: () => connection,
            },
          } as unknown as Communities
        }
        cards={
          {
            subscribe: () => () => {},
            snapshot: () => cards,
          } as unknown as SettingsCards
        }
        selected="moderation/membership"
        onSection={() => {}}
      />
    </nav>,
  );

  const membership = screen.getByRole("button", { name: "Membership" });
  expect(membership).toHaveAttribute("aria-current", "page");
  expect(membership.closest("section")).toHaveTextContent("Community admin");
  expect(membership.closest("section")).not.toHaveTextContent("Primary");
  expect(membership.querySelector("svg")).toHaveClass("tabler-icon-copy");
  expect(
    screen
      .getByRole("button", { name: "Personal groups" })
      .querySelector("svg"),
  ).toHaveClass("tabler-icon-folder");
  expect(
    screen
      .getByRole("button", { name: "Hosted communities" })
      .querySelector("svg"),
  ).toHaveClass("tabler-icon-world");
});

it.each([null, "primary"])(
  "keeps one usable Profile entry with community %s",
  async (selected) => {
    const client = {
      selected,
      memberships: [{ id: "primary", name: "Primary" }],
    };
    const connection = { scope: "settings-sidebar-profile-test" };
    const cards: ReturnType<SettingsCards["snapshot"]> = [];
    const onSection = vi.fn();
    render(
      <nav aria-label="Settings sections">
        <SettingsSidebar
          communities={
            {
              subscribe: () => () => {},
              snapshot: () => client,
              relay: { subscribe: () => () => {}, snapshot: () => connection },
            } as unknown as Communities
          }
          cards={
            {
              subscribe: () => () => {},
              snapshot: () => cards,
            } as unknown as SettingsCards
          }
          selected="profile"
          onSection={onSection}
        />
      </nav>,
    );
    const profile = screen.getByRole("button", {
      name: "Profile",
    });
    expect(profile).toHaveAttribute("aria-current", "page");
    expect(profile.closest("section")).toHaveTextContent(
      selected ? "Community" : "Personal space",
    );
    await userEvent.setup().click(profile);
    expect(onSection).toHaveBeenCalledWith("profile");
    if (selected) {
      const group = profile.closest("section");
      if (!group) throw new Error("Missing community settings group");
      expect(
        within(group).getByRole("heading", { name: "Community" }),
      ).toBeVisible();
      const copy = screen.getByRole("button", {
        name: "Copy community URL, primary.example",
      });
      expect(copy).not.toHaveAttribute("aria-current");
      const reference = copy.closest("section");
      expect(reference).not.toBe(group);
      expect(reference?.nextElementSibling).toBe(group);
      if (!reference) throw new Error("Missing community reference section");
      expect(within(reference).queryByRole("heading")).toBeNull();
      expect(within(group).queryByRole("link")).toBeNull();
      const leave = screen.getByRole("button", { name: "Leave or remove" });
      expect(leave.closest("section")).toHaveTextContent("Community");
      expect(leave.querySelector("svg")).toHaveClass("tabler-icon-logout");
    } else {
      expect(screen.queryByRole("heading", { name: "Community" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Leave or remove" }),
      ).toBeNull();
    }
  },
);

it("uses a contributed icon and preserves the chat fallback", () => {
  const client = {
    selected: "primary",
    memberships: [{ id: "primary", name: "Primary" }],
  };
  const connection = { scope: "icon-test" };
  const entries = [
    {
      id: "compute",
      key: "mesh/compute",
      pluginId: "mesh",
      revision: "one",
      title: "Compute",
      component: () => null,
      icon: CpuIcon,
    },
    {
      id: "other",
      key: "other/card",
      pluginId: "other",
      revision: "one",
      title: "Other",
      component: () => null,
    },
  ];
  render(
    <SettingsSidebar
      communities={
        {
          snapshot: () => client,
          subscribe: () => () => {},
          relay: { snapshot: () => connection, subscribe: () => () => {} },
        } as unknown as Communities
      }
      cards={
        {
          snapshot: () => entries,
          subscribe: () => () => {},
        } as unknown as SettingsCards
      }
      onSection={() => {}}
    />,
  );
  const reference = render(
    <>
      <CpuIcon data-testid="cpu-reference" />
      <ChatCircleIcon data-testid="chat-reference" />
    </>,
  );
  expect(
    screen.getByRole("button", { name: "Compute" }).querySelector("svg")
      ?.innerHTML,
  ).toBe(reference.getByTestId("cpu-reference").innerHTML);
  expect(
    screen.getByRole("button", { name: "Other" }).querySelector("svg")
      ?.innerHTML,
  ).toBe(reference.getByTestId("chat-reference").innerHTML);
  expect(
    screen.getByRole("button", { name: "Compute" }).closest("section"),
  ).toHaveTextContent("Community");
});

it.each([
  [0, "Manage plugins"],
  [2, "Manage plugins2 recommended plugins"],
])(
  "shows %s managed plugin recommendations on Manage plugins only",
  (count, name) => {
    const client = { selected: null, memberships: [] };
    const connection = {};
    const cards: ReturnType<SettingsCards["snapshot"]> = [];
    render(
      <nav aria-label="Settings sections">
        <SettingsSidebar
          communities={
            {
              subscribe: () => () => {},
              snapshot: () => client,
              relay: { subscribe: () => () => {}, snapshot: () => connection },
            } as unknown as Communities
          }
          cards={
            {
              subscribe: () => () => {},
              snapshot: () => cards,
            } as unknown as SettingsCards
          }
          recommendations={count}
          onSection={() => {}}
        />
      </nav>,
    );
    expect(screen.getByRole("button", { name })).toBeVisible();
    expect(screen.getByRole("button", { name: "Appearance" })).toBeVisible();
  },
);
