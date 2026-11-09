import { expect, it } from "vitest";
import { inboxRouteTarget, inboxTarget, isInboxRoute, routeOf } from "./route";

it.each([
  {},
  { attention: "unread" },
  { attention: "all" },
  { activity: "all" },
  { activity: "threads" },
  { activity: "mentions" },
  { activity: "dms" },
  { activity: "all", attention: "unread" },
  { show: "archived" },
  { show: "inbox" },
  { sender: "humans" },
  { sender: "agents" },
  { sender: "everyone" },
  { activity: "dms", sender: "agents", show: "archived", attention: "unread" },
  { drafts: true },
  // buzz:// plugin links carry every route value as a string.
  { drafts: "true" },
])("accepts the filter params %j", (params) => {
  expect(isInboxRoute(params)).toBe(true);
});

it.each([
  null,
  true,
  3,
  "threads",
  ["threads"],
  { attention: "read" },
  { activity: "drafts" },
  { activity: 1 },
  { activity: null },
  { show: "drafts" },
  { sender: "people" },
  { drafts: false },
  { drafts: "false" },
  { drafts: "" },
  // Drafts has no type, sender, status or attention filters to apply.
  { drafts: true, activity: "dms" },
  { drafts: true, show: "inbox" },
  { unknown: "x" },
])("rejects the filter params %j", (params) => {
  expect(isInboxRoute(params)).toBe(false);
});

it("reads a route only from a version 1 page target", () => {
  const params = { activity: "dms" } as const;
  expect(routeOf(inboxRouteTarget(params))).toEqual(params);
  expect(routeOf(inboxRouteTarget({ activity: "dms" }))).toEqual(params);
  expect(routeOf({ version: 1, kind: "home" })).toBeUndefined();
  expect(
    routeOf({
      version: 1,
      kind: "page",
      pluginId: "buzz.inbox",
      pageId: "inbox",
    }),
  ).toBeUndefined();
  expect(
    routeOf({
      version: 1,
      kind: "page",
      pluginId: "buzz.inbox",
      pageId: "inbox",
      route: { version: 2, params },
    }),
  ).toBeUndefined();
  expect(routeOf(undefined)).toBeUndefined();
});

it("drops a link's retired Archived and Drafts choices", () => {
  const at = (params: Record<string, string | boolean>) =>
    routeOf({ ...inboxTarget, route: { version: 1, params } });
  expect(at({ show: "archived", sender: "agents" })).toEqual({
    sender: "agents",
  });
  expect(at({ show: "inbox" })).toEqual({});
  expect(at({ drafts: "true" })).toEqual({});
});
