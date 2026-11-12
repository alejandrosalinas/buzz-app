import { describe, expect, test } from "vitest";
import type { RegisteredPage } from "../../features/pages/service";
import {
  BellIcon,
  BrowserIcon,
  ChatsCircleIcon,
  RobotIcon,
} from "../../shared/design-system/icons/index";
import {
  navigationOwner,
  pagePlacement,
  orderPages,
  pagePresentation,
} from "./presentation";

function page(key: string, title: string, icon?: string): RegisteredPage {
  const separator = key.indexOf("/");
  const pluginId = key.slice(0, separator);
  const id = key.slice(separator + 1);
  return {
    key,
    pluginId,
    id,
    title,
    revision: "bundled",
    component: () => null,
    ...(icon === undefined ? {} : { icon }),
  };
}

const messages = page("buzz.channels/channels", "Channels");
const inbox = page("buzz.inbox/inbox", "Inbox");
const bestie = page("buzz.bestie/bestie", "Bestie");
const projects = page("fixture.projects/projects", "Projects");

test("bundled page order ignores activation order without mutating the registry", () => {
  const input = Object.freeze([projects, bestie, messages, inbox]);
  expect(orderPages(input)).toEqual([messages, inbox, bestie, projects]);
  expect(input).toEqual([projects, bestie, messages, inbox]);
  expect(orderPages([messages, projects])).toEqual([messages, projects]);
  expect(orderPages([projects])).toEqual([projects]);
  expect(orderPages([])).toEqual([]);
});

test("other pages sort by label then full key and cannot claim bundled slots", () => {
  const alpha = page("example.alpha/page", "Alpha");
  const alpha2 = page("example.other/page", "Alpha");
  const foreignInbox = page("example.mail/inbox", "Inbox");
  const sameId = page("example.custom/projects", "Projects");
  const zulu = page("example.zulu/page", "Zulu");
  const expected = [
    messages,
    inbox,
    bestie,
    alpha,
    alpha2,
    foreignInbox,
    sameId,
    projects,
    zulu,
  ];
  expect(orderPages([...expected].reverse())).toEqual(expected);
  expect(
    orderPages([
      sameId,
      projects,
      alpha2,
      bestie,
      zulu,
      foreignInbox,
      messages,
      inbox,
      alpha,
    ]),
  ).toEqual(expected);
});

test("bundled pages get their own icons", () => {
  expect(pagePresentation(inbox).icon).toBe(BellIcon);
  expect(pagePresentation(page("buzz.agents/agents", "Agents")).icon).toBe(
    RobotIcon,
  );
  expect(pagePresentation(page("example.mail/inbox", "Inbox")).icon).toBe(
    BrowserIcon,
  );
});

describe("page mark precedence", () => {
  const owl = "data:image/svg+xml,%3Csvg%20id%3D%22owl%22%3E%3C%2Fsvg%3E";
  const fox = "data:image/png;base64,iVBORfox";

  test.each([
    [
      "an external page with an icon gets its image beside BrowserIcon",
      page("example.plugin/main", "Example", owl),
      { label: "Example", icon: BrowserIcon, image: owl },
    ],
    [
      "an external page without an icon gets no image key",
      page("example.plugin/main", "Example"),
      { label: "Example", icon: BrowserIcon },
    ],
    [
      "bundled Inbox keeps BellIcon and ignores a declared icon",
      page("buzz.inbox/inbox", "Inbox", owl),
      { label: "Inbox", icon: BellIcon },
    ],
    [
      "bundled channels stays Messages and ignores a declared icon",
      page("buzz.channels/channels", "Channels", owl),
      { label: "Messages", icon: ChatsCircleIcon },
    ],
    [
      "an external page with local id channels keeps its own title and image",
      page("example.chat/channels", "Chat", owl),
      { label: "Chat", icon: BrowserIcon, image: owl },
    ],
  ] as const)("%s", (_name, input, mark) => {
    const { tone: _tone, ...actual } = pagePresentation(input);
    expect(actual).toStrictEqual(mark);
  });

  test("two plugins with local id main each get their own image", () => {
    const one = pagePresentation(page("example.one/main", "One", owl));
    const two = pagePresentation(page("example.two/main", "Two", fox));
    expect(one).toHaveProperty("image", owl);
    expect(two).toHaveProperty("image", fox);
  });
});

test.each([undefined, "toolbar"] as const)(
  "bundled Messages uses host placement regardless of registered %s placement",
  (placement) => {
    expect(
      pagePlacement({
        ...messages,
        primary: true,
        ...(placement ? { placement } : {}),
      }),
    ).toBe("dock");
  },
);

test.each([undefined, "dock"] as const)(
  "bundled Activity is a Messages sidebar row regardless of registered %s placement",
  (placement) => {
    expect(
      pagePlacement({
        ...inbox,
        primary: true,
        ...(placement ? { placement } : {}),
      }),
    ).toBe("sidebar");
  },
);

test.each([
  [undefined, "sidebar"],
  ["sidebar", "sidebar"],
  ["dock", "dock"],
  // Pre-dock names stay accepted and resolve to the dock.
  ["topbar", "dock"],
  ["toolbar", "dock"],
] as const)("a plugin's %s placement resolves to %s", (placement, expected) => {
  expect(
    pagePlacement({
      ...page("example.plugin/main", "Plugin"),
      primary: true,
      ...(placement ? { placement } : {}),
    }),
  ).toBe(expected);
});

describe("navigation owner", () => {
  const primary = (
    key: string,
    fields: Partial<RegisteredPage> = {},
  ): RegisteredPage => ({ ...page(key, key), primary: true, ...fields });
  const listed = [
    primary("example.sidebar/main"),
    primary("example.listed/main", { placement: "sidebar" }),
    primary("example.own-sidebar/main", { sidebar: () => null }),
  ];
  const entries = [
    primary(messages.key),
    ...listed,
    primary("example.header/main", { placement: "topbar" }),
    primary("example.tools/main", { placement: "toolbar" }),
    primary("example.linked/main", { primary: false, placement: "sidebar" }),
  ];
  test.each([
    // Every external page listed in the Messages sidebar keeps Messages
    // selected, including one that supplies its own sidebar.
    ["example.sidebar/main", messages.key],
    ["example.listed/main", messages.key],
    ["example.own-sidebar/main", messages.key],
    // External dock apps own themselves.
    ["example.header/main", "example.header/main"],
    ["example.tools/main", "example.tools/main"],
    // Destinations without a navigation entry select nothing in the dock.
    ["example.linked/main", "example.linked/main"],
    ["settings", "settings"],
    ["missing/page", "missing/page"],
  ])("%s belongs to %s", (selected, owner) => {
    expect(navigationOwner(entries, selected)).toBe(owner);
  });
  // Without Messages there is no app to keep selected.
  test.each(listed.map(({ key }) => key))(
    "%s owns itself when Messages is absent",
    (selected) => {
      const pages = entries.filter((page) => page.key !== messages.key);
      expect(navigationOwner(pages, selected)).toBe(selected);
    },
  );
});
