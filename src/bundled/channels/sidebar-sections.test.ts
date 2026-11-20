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
it("allows every kind in Starred and workspaces, and each kind in its home section", () => {
  for (const [key, kinds] of [
    ["starred", ["solo", "channel", "forum", "dm"]],
    ["group:work", ["solo", "channel", "forum", "dm"]],
    ["solo", ["solo"]],
    ["channels", ["channel", "forum"]],
    ["dms", ["dm"]],
    ["forums", []],
  ] as const)
    expect(sidebarDropRowKinds(key)).toEqual(kinds);
  expect(isChannelSectionKey("starred")).toBe(false);
});
it("keeps Starred visible and lists only authorized starred rows", () => {
  expect(
    sidebarSections([]).find(({ key }) => key === "starred")?.rows,
  ).toEqual([]);
  const preferences = {
    sections: [],
    assignments: {},
    starred: ["alpha"],
    muted: [],
  };
  expect(
    sidebarSections([], preferences).find(({ key }) => key === "starred")?.rows,
  ).toEqual([]);
  expect(
    sidebarSections([row("alpha")], preferences).find(
      ({ key }) => key === "starred",
    )?.rows,
  ).toEqual([row("alpha")]);
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
    row("grouped-forum", { channelType: "forum" }),
    row("loose-forum", { channelType: "forum" }),
    row("solo", { channelType: "solo" }),
  ];
  const preferences = {
    sections: [{ id: "channels", name: "Channels", icon: ":party:", order: 0 }],
    assignments: {
      star: "channels",
      work: "channels",
      revoked: "channels",
      "grouped-dm": "channels",
      "grouped-forum": "channels",
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
    { key: "solo", ids: [] },
    { key: "starred", ids: ["forum", "solo", "star", "starred-dm"] },
    { key: "group:channels", ids: ["grouped-dm", "grouped-forum", "work"] },
    { key: "channels", ids: ["loose-forum", "other"] },
    { key: "dms", ids: ["home-dm"] },
  ];
  expect(project(roster, new Set(["hidden-dm"]))).toEqual(expectedProjection);
  assertExactlyOnce(project(roster, new Set(["hidden-dm"])), [
    "home-dm",
    "grouped-dm",
    "starred-dm",
  ]);
  expect(
    sidebarSections(roster, preferences).find(
      ({ key }) => key === "group:channels",
    )?.icon,
  ).toBe(":party:");
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
  ).toEqual(["forum", "solo", "star"]);
  expect(sidebarSections([])).toEqual([
    { key: "solo", title: "Solo", icon: undefined, rows: [] },
    { key: "starred", title: "Starred", icon: undefined, rows: [] },
    { key: "channels", title: "Team", icon: undefined, rows: [] },
    { key: "dms", title: "Direct messages", icon: undefined, rows: [] },
  ]);
  expect(
    sidebarSections(roster, undefined, new Set(["hidden-dm"])).flatMap(
      (section) => section.rows.map((channel) => channel.id),
    ),
  ).toEqual([
    "solo",
    "forum",
    "grouped-forum",
    "loose-forum",
    "other",
    "star",
    "work",
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
    sort: { "section:work": "recent" as const },
  };
  expect(
    sidebarSections(roster, preferences).map((section) => [
      section.key,
      section.rows.map((channel) => channel.id),
    ]),
  ).toEqual([
    ["solo", []],
    ["starred", []],
    ["group:work", ["new", "a-id", "z-id", "quiet-a", "quiet-b"]],
    ["channels", ["forum-new", "forum-old"]],
    ["dms", []],
  ]);
  expect(
    sidebarSections(roster)
      .find(({ key }) => key === "channels")
      ?.rows.map((channel) => channel.id),
  ).toEqual([
    "quiet-a",
    "quiet-b",
    "forum-new",
    "forum-old",
    "a-id",
    "z-id",
    "new",
  ]);
});
it("Recent places a chat without known activity by when it was created", () => {
  const solo = { channelType: "solo" as const };
  const roster = [
    row("talked", {
      ...solo,
      name: "Talked",
      createdAt: 5,
      lastActivityAt: 25,
    }),
    row("queued-earlier", {
      ...solo,
      name: "Queued earlier",
      createdAt: 40,
      lastActivityAt: 20,
    }),
    row("unknown", { ...solo, name: "Unknown" }),
    row("old-empty", { ...solo, name: "Old empty", createdAt: 10 }),
    row("just-started", { ...solo, name: "Just started", createdAt: 30 }),
  ];
  expect(
    sidebarSections(roster)
      .find(({ key }) => key === "solo")
      ?.rows.map((channel) => channel.id),
  ).toEqual([
    "queued-earlier",
    "just-started",
    "talked",
    "old-empty",
    "unknown",
  ]);
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
    ["solo", []],
    ["starred", ["alpha", "beta"]],
    ["group:work", []],
    ["channels", []],
    ["dms", []],
  ]);
  expect(placements(["alpha"])).toEqual([
    ["solo", []],
    ["starred", ["alpha"]],
    ["group:work", ["beta"]],
    ["channels", []],
    ["dms", []],
  ]);
  expect(saved.assignments).toEqual({ beta: "work" });
});

it.each(["starred", "section:work", "channels", "dms"])(
  "%s Recent affects only its own section",
  (key) => {
    const keys = ["starred", "section:work", "channels", "dms"];
    const channels = keys.flatMap((section, i) => [
      row(`a-${i}`, {
        name: "Alpha",
        lastActivityAt: 10,
        ...(section === "dms" ? { channelType: "dm" as const } : {}),
      }),
      row(`z-${i}`, {
        name: "Zulu",
        lastActivityAt: 20,
        ...(section === "dms" ? { channelType: "dm" as const } : {}),
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
      sections
        .filter((section) => section.key !== "solo")
        .map((section) => section.rows.map((row) => row.name)),
    ).toEqual(
      keys.map((section) =>
        section === key ? ["Zulu", "Alpha"] : ["Alpha", "Zulu"],
      ),
    );
  },
);
