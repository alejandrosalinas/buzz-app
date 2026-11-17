import { expect, it } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import {
  orderContributedSidebarSections,
  isChannelSectionKey,
  sidebarDropRowKinds,
  sidebarSections,
} from "./sidebar-sections";

it("keeps contributed order stable and lets saved preferences lead", () => {
  const sections = [
    { key: "plugin/a" },
    { key: "plugin/b" },
    { key: "plugin/c" },
  ];
  expect(
    orderContributedSidebarSections(sections, ["plugin/c", "plugin/a"]).map(
      ({ key }) => key,
    ),
  ).toEqual(["plugin/c", "plugin/a", "plugin/b"]);
});

const row = (
  id: string,
  extra: Partial<ChannelSummary> = {},
): ChannelSummary => ({ id, name: id, ...extra });
it("identifies custom and general channel sections", () => {
  expect(isChannelSectionKey("channels")).toBe(true);
  expect(isChannelSectionKey("group:engineering")).toBe(true);
  expect(isChannelSectionKey("starred")).toBe(false);
  expect(isChannelSectionKey("forums")).toBe(false);
  expect(isChannelSectionKey("dms")).toBe(false);
});
it("allows channel and DM drops into Starred and groups, and each back to its own section", () => {
  for (const [key, kinds] of [
    ["starred", ["channel", "dm"]],
    ["group:work", ["channel", "dm"]],
    ["channels", ["channel"]],
    ["dms", ["dm"]],
    ["forums", []],
  ] as const)
    expect(sidebarDropRowKinds(key)).toEqual(kinds);
  expect(isChannelSectionKey("starred")).toBe(false);
});
it("hides empty Starred and shows it only for an authorized starred row", () => {
  expect(sidebarSections([]).some(({ key }) => key === "starred")).toBe(false);
  const preferences = {
    sections: [],
    assignments: {},
    starred: ["alpha"],
    muted: [],
  };
  expect(
    sidebarSections([], preferences).some(({ key }) => key === "starred"),
  ).toBe(false);
  expect(sidebarSections([row("alpha")], preferences)[0]).toMatchObject({
    key: "starred",
    rows: [row("alpha")],
  });
});
it("intersects groups/stars with active authorized streams and movable DMs", () => {
  const roster = [
    row("star"),
    row("work"),
    row("other"),
    row("archived", { archived: true }),
    row("hidden", { hidden: true }),
    row("home-dm", { channelType: "dm" }),
    row("grouped-dm", { channelType: "dm", participants: ["a", "b"] }),
    row("starred-dm", { channelType: "dm" }),
    row("hidden-dm", { channelType: "dm" }),
    row("forum", { channelType: "forum" }),
    row("solo", { channelType: "solo" }),
  ];
  const preferences = {
    sections: [{ id: "channels", name: "Channels", icon: ":party:", order: 0 }],
    assignments: {
      star: "channels",
      work: "channels",
      revoked: "channels",
      "grouped-dm": "channels",
      "starred-dm": "channels",
      "hidden-dm": "channels",
      other: "missing",
    },
    muted: [],
    starred: [
      "star",
      "archived",
      "hidden",
      "revoked",
      "starred-dm",
      "hidden-dm",
      "forum",
      "solo",
    ],
  };
  const project = (
    channels: readonly ChannelSummary[],
    hiddenDms: ReadonlySet<string> = new Set(),
  ) =>
    sidebarSections(channels, preferences, hiddenDms).map((section) => ({
      key: section.key,
      ids: section.rows.map((channel) => channel.id),
    }));
  const assertExactlyOnce = (
    projection: ReturnType<typeof project>,
    ids: readonly string[],
  ) => {
    const placements = projection.flatMap(({ key, ids: rowIds }) =>
      rowIds.map((id) => ({ id, key })),
    );
    for (const id of ids)
      expect(
        placements.filter((placement) => placement.id === id),
      ).toHaveLength(1);
  };
  const expectedProjection = [
    { key: "starred", ids: ["solo", "star", "starred-dm"] },
    { key: "group:channels", ids: ["grouped-dm", "work"] },
    { key: "channels", ids: ["other"] },
    { key: "forums", ids: ["forum"] },
    { key: "dms", ids: ["home-dm"] },
  ];
  expect(project(roster, new Set(["hidden-dm"]))).toEqual(expectedProjection);
  assertExactlyOnce(project(roster, new Set(["hidden-dm"])), [
    "home-dm",
    "grouped-dm",
    "starred-dm",
  ]);
  expect(sidebarSections(roster, preferences)[1]?.icon).toBe(":party:");
  // Hidden conversations remain absent even when their saved placement is stale.
  const hiddenProjection = project(
    roster,
    new Set(["starred-dm", "hidden-dm"]),
  );
  const visibleAfterHide = hiddenProjection.flatMap(({ ids }) => ids);
  expect(visibleAfterHide).not.toContain("starred-dm");
  expect(visibleAfterHide).not.toContain("hidden-dm");
  expect(
    project(
      roster.filter((channel) => channel.id !== "starred-dm"),
      new Set(["hidden-dm"]),
    ).find(({ key }) => key === "starred")?.ids,
  ).toEqual(["solo", "star"]);
  expect(sidebarSections([])).toEqual([
    { key: "channels", title: "Channels", icon: undefined, rows: [] },
    { key: "dms", title: "Direct messages", icon: undefined, rows: [] },
  ]);
  expect(
    sidebarSections(roster, undefined, new Set(["hidden-dm"])).flatMap(
      (section) => section.rows.map((channel) => channel.id),
    ),
  ).toEqual([
    "other",
    "solo",
    "star",
    "work",
    "forum",
    "grouped-dm",
    "home-dm",
    "starred-dm",
  ]);
});

it("sorts every section independently with deterministic inactive and tie fallbacks", () => {
  const roster = [
    row("z-id", { name: "same", lastActivityAt: 20 }),
    row("a-id", { name: "Same", lastActivityAt: 20 }),
    row("new", { name: "Zulu", lastActivityAt: 30 }),
    row("quiet-b", { name: "beta" }),
    row("quiet-a", { name: "Alpha" }),
    row("forum-old", {
      name: "Forum old",
      channelType: "forum",
      lastActivityAt: 5,
    }),
    row("forum-new", {
      name: "Forum new",
      channelType: "forum",
      lastActivityAt: 10,
    }),
  ];
  const preferences = {
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: {
      "z-id": "work",
      "a-id": "work",
      new: "work",
      "quiet-b": "work",
      "quiet-a": "work",
    },
    starred: [],
    muted: [],
    sort: { "section:work": "recent" as const, forums: "alpha" as const },
  };
  expect(
    sidebarSections(roster, preferences).map((section) => [
      section.key,
      section.rows.map((channel) => channel.id),
    ]),
  ).toEqual([
    ["group:work", ["new", "a-id", "z-id", "quiet-a", "quiet-b"]],
    ["channels", []],
    ["forums", ["forum-new", "forum-old"]],
    ["dms", []],
  ]);
  expect(sidebarSections(roster)[0]?.rows.map((channel) => channel.id)).toEqual(
    ["quiet-a", "quiet-b", "a-id", "z-id", "new"],
  );
});
it("Star projection is exclusive and retains empty saved groups", () => {
  const channels = [row("alpha"), row("beta")];
  const saved = {
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: { beta: "work" },
    starred: ["alpha", "beta"],
    muted: [],
  };
  const placements = (starred: string[]) =>
    sidebarSections(channels, { ...saved, starred }).map((section) => [
      section.key,
      section.rows.map((channel) => channel.id),
    ]);
  expect(placements(saved.starred)).toEqual([
    ["starred", ["alpha", "beta"]],
    ["group:work", []],
    ["channels", []],
    ["dms", []],
  ]);
  expect(placements(["alpha"])).toEqual([
    ["starred", ["alpha"]],
    ["group:work", ["beta"]],
    ["channels", []],
    ["dms", []],
  ]);
  expect(saved.assignments).toEqual({ beta: "work" });
});

it.each(["starred", "section:work", "channels", "forums", "dms"])(
  "%s Recent affects only its own section",
  (key) => {
    const keys = ["starred", "section:work", "channels", "forums", "dms"];
    const channels = keys.flatMap((section, i) => [
      row(`a-${i}`, {
        name: "Alpha",
        lastActivityAt: 10,
        ...(section === "forums"
          ? { channelType: "forum" as const }
          : section === "dms"
            ? { channelType: "dm" as const }
            : {}),
      }),
      row(`z-${i}`, {
        name: "Zulu",
        lastActivityAt: 20,
        ...(section === "forums"
          ? { channelType: "forum" as const }
          : section === "dms"
            ? { channelType: "dm" as const }
            : {}),
      }),
    ]);
    const sections = sidebarSections(channels, {
      sections: [{ id: "work", name: "Work", order: 0 }],
      assignments: { "a-1": "work", "z-1": "work" },
      starred: ["a-0", "z-0"],
      muted: [],
      sort: { [key]: "recent" },
    });
    expect(
      sections.map((section) => section.rows.map((row) => row.name)),
    ).toEqual(
      keys.map((section) =>
        section === key ? ["Zulu", "Alpha"] : ["Alpha", "Zulu"],
      ),
    );
  },
);
