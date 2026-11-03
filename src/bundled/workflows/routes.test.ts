import { expect, it } from "vitest";
import { buzzLinkTarget } from "../../features/navigation/buzz-links";
import { linkedPageTarget } from "../../features/pages/plugin-link";
import type { RegisteredPage } from "../../features/pages/service";
import { routedWorkflow, workflowsRoute, workflowsTarget } from "./routes";
import { fixtureChannel, fixtureDefinition, fixtureViewer } from "./fixtures";

const selected = {
  channel: fixtureChannel,
  owner: fixtureViewer,
  workflow: fixtureDefinition.id,
};

it.each([
  [{}, {}],
  [{ channel: fixtureChannel }, { channel: fixtureChannel }],
  [{ owner: fixtureViewer }, { owner: fixtureViewer }],
  [{ owner: fixtureViewer.toUpperCase() }, { owner: fixtureViewer }],
  [
    { channel: fixtureChannel, owner: fixtureViewer },
    { channel: fixtureChannel, owner: fixtureViewer },
  ],
  [
    { channel: "launch", owner: fixtureViewer },
    { channel: "launch", owner: fixtureViewer },
  ],
  [selected, selected],
  [{ ...selected, extra: "1" }, selected],
])("accepts %j", (route, expected) => {
  expect(workflowsRoute(route)).toEqual(expected);
});

it.each([
  undefined,
  null,
  "route",
  [],
  { channel: "" },
  { channel: "bad id" },
  { channel: "-launch" },
  { channel: 1 },
  { owner: "AB".repeat(31) },
  { owner: fixtureViewer.slice(1) },
  { owner: 1 },
  { workflow: fixtureDefinition.id },
  { channel: fixtureChannel, workflow: fixtureDefinition.id },
  { owner: fixtureViewer, workflow: fixtureDefinition.id },
  { ...selected, workflow: "not-a-uuid" },
])("rejects %j", (route) => {
  expect(workflowsRoute(route as never)).toBeUndefined();
});

it("names the selected workflow only when the route selects one", () => {
  expect(routedWorkflow(workflowsRoute(selected))).toEqual({
    id: fixtureDefinition.id,
    channelId: fixtureChannel,
    owner: fixtureViewer,
  });
  expect(routedWorkflow(workflowsRoute({ channel: fixtureChannel }))).toBe(
    undefined,
  );
});

it("replaces or drops the page route without losing its scope", () => {
  const scope = { viewer: fixtureViewer, communityOrigin: "https://a.test" };
  const page = {
    version: 1,
    kind: "page",
    pluginId: "buzz.workflows",
    pageId: "workflows",
    scope,
    route: { version: 1, params: selected },
  } as const;
  expect(workflowsTarget(page)).toEqual({ ...page, route: undefined });
  expect(workflowsTarget(page, { channel: fixtureChannel })).toEqual({
    ...page,
    route: { version: 1, params: { channel: fixtureChannel } },
  });
});

it("routes a message's link to the Workflows page and drops malformed data", () => {
  const scope = { viewer: fixtureViewer, communityOrigin: "https://a.test" };
  const page = {
    pluginId: "buzz.workflows",
    id: "workflows",
    route: { version: 1, validate: (params) => !!workflowsRoute(params) },
  } as RegisteredPage;
  const open = (href: string) => {
    const link = buzzLinkTarget(href, scope);
    if (link?.kind !== "plugin") throw new Error("Not a plugin link");
    return linkedPageTarget(link, page);
  };
  expect(
    open(
      `buzz://plugin?id=buzz.workflows&page=workflows&route.channel=${fixtureChannel}&route.owner=${fixtureViewer}`,
    ),
  ).toMatchObject({
    scope,
    route: {
      version: 1,
      params: { channel: fixtureChannel, owner: fixtureViewer },
    },
  });
  expect(
    open(
      `buzz://plugin?id=buzz.workflows&page=workflows&route.channel=${fixtureChannel}&route.owner=nobody`,
    ),
  ).not.toHaveProperty("route");
});
