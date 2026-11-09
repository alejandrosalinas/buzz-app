// @vitest-environment jsdom
import { isTauri } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import type { SettingsCard } from "../features/settings/service";
import type { Contribution } from "../plugins/contributions";
import {
  developerMode,
  isBuiltInSettingsSection,
  settingsSections,
} from "./settings-sections";

const card = (
  key: string,
  extra: Partial<SettingsCard> = {},
): Contribution<SettingsCard> => {
  const [pluginId = "", id = ""] = key.split("/");
  return {
    id,
    key,
    pluginId,
    revision: "one",
    title: key,
    component: () => null,
    ...extra,
  };
};
const cards = [
  // Plugin activation/re-enable order must not determine community navigation.
  card("buzz.pairing/mobile", { personal: true }),
  card("buzz.emoji/custom-emoji"),
  card("buzz.channels/templates", { group: "App" }),
  card("example/groups"),
  card("other/groups"),
  card("example/membership", { section: "administration" }),
  card("example/hosted", { group: "Communities" }),
  card("block.builderlab/login", {
    group: "Plugins",
    title: "Builderlab",
  }),
];
vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(() => false) }));

const primary = { id: "primary", name: "Primary" };
const app = [
  "identity",
  "appearance",
  "notifications",
  "shortcuts",
  "agents",
  "decisions",
  "buzz.channels/templates",
  "updates",
  ...(developerMode ? ["developer"] : []),
];
const plugins = ["plugins", "block.builderlab/login"];
const outline = (model: ReturnType<typeof settingsSections>) =>
  model.groups.map((group) => [
    group.id,
    group.label,
    group.sections.map((section) => section.id),
  ]);

it.each([
  [
    "a selected community",
    primary,
    "profile",
    [
      [
        "community",
        "Community",
        [
          "profile",
          "local-settings",
          "buzz.emoji/custom-emoji",
          "example/groups",
          "other/groups",
          "buzz.pairing/mobile",
          "leave-community",
        ],
      ],
      ["administration", "Community admin", ["example/membership"]],
      ["app", "Buzz", app],
      ["plugins", "Plugins", plugins],
      ["group:Communities", "Communities", ["example/hosted"]],
    ],
  ],
  [
    "Personal",
    undefined,
    "appearance",
    [
      ["personal", "Personal space", ["profile", "buzz.pairing/mobile"]],
      ["app", "Buzz", app],
      ["plugins", "Plugins", plugins],
      ["group:Communities", "Communities", ["example/hosted"]],
    ],
  ],
])(
  "orders Settings groups and defaults for %s",
  (_, community, initial, groups) => {
    const model = settingsSections(cards, community);
    expect(outline(model)).toEqual(groups);
    expect(model.defaultSection).toBe(initial);
    expect(model.sections.map((section) => section.id)).toEqual(
      groups.flatMap(([, , ids]) => ids),
    );
  },
);

it("classifies built-in sections apart from plugin card keys", () => {
  for (const id of [
    "profile",
    "identity",
    "local-settings",
    "plugins",
    "leave-community",
    ...app.filter((id) => id !== "buzz.channels/templates"),
  ])
    expect(isBuiltInSettingsSection(id)).toBe(true);
  expect(isBuiltInSettingsSection("developer")).toBe(developerMode);
  for (const id of [
    "example/groups",
    "buzz.channels/templates",
    "Profile",
    "",
    "administration",
  ])
    expect(isBuiltInSettingsSection(id)).toBe(false);
});

it("keeps Local settings after Profile under the host’s Community heading", () => {
  const model = settingsSections(cards, {
    name: "Saved",
    publishedName: "Published",
    localName: "Local label",
  });
  expect(model.groups[0]?.label).toBe("Community");
  expect(
    model.groups[0]?.sections.slice(0, 2).map((section) => section.id),
  ).toEqual(["profile", "local-settings"]);
});

it("lists Security after Identity only in the desktop app", () => {
  const ids = () =>
    settingsSections([], undefined)
      .groups.find((group) => group.id === "app")
      ?.sections.map((section) => section.id)
      .slice(0, 2);
  expect(ids()).toEqual(["identity", "appearance"]);
  vi.mocked(isTauri).mockReturnValue(true);
  expect(ids()).toEqual(["identity", "security"]);
  vi.mocked(isTauri).mockReturnValue(false);
});
