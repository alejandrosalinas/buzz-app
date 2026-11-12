import { expect, it } from "vitest";
import type { JsonValue, OpenTarget } from "../navigation/targets";
import { isChannelRoute, soloDraft, soloDraftTarget } from "./routes";

const viewer = "c".repeat(64);
const scope = { viewer, communityOrigin: "https://relay.test" };
const partition = `https://relay.test:${viewer}`;
const agent = "a".repeat(64);
const page = (
  pluginId: string,
  pageId: string,
  params?: JsonValue,
): OpenTarget => ({
  version: 1,
  kind: "page",
  pluginId,
  pageId,
  scope,
  ...(params === undefined ? {} : { route: { version: 1, params } }),
});

it("accepts empty, new-message and Solo draft destinations", () => {
  expect(isChannelRoute("empty")).toBe(true);
  expect(isChannelRoute("new-message")).toBe(true);
  expect(soloDraft({ kind: "solo-draft" })).toEqual({});
  expect(soloDraft({ kind: "solo-draft", project: "p", agent })).toEqual({
    project: "p",
    agent,
  });
});

it("rejects foreign route kinds and draft payloads", () => {
  for (const params of [
    null,
    [],
    "solo-draft",
    // Inbox and Bestie are pages of their own, not Channels placeholders.
    "Inbox",
    "Bestie",
    {},
    { kind: "other" },
    { kind: "solo-draft", project: "" },
    { kind: "solo-draft", project: 1 },
    { kind: "solo-draft", agent: "not-a-key" },
    { kind: "solo-draft", text: "private draft" },
    { kind: "solo-draft", linked: "invalid" },
  ]) {
    expect(isChannelRoute(params)).toBe(false);
    expect(soloDraft(params)).toBeUndefined();
  }
});

it("builds Solo draft destinations in the community", () => {
  expect(soloDraftTarget(partition, { agent })).toEqual(
    page("buzz.channels", "channels", { kind: "solo-draft", agent }),
  );
  expect(() => soloDraftTarget("bad")).toThrow();
});

it("keeps a region draft's label and refuses a malformed or linked one", () => {
  const region = "buzz.region:example.tasks:tasks";
  expect(soloDraft({ kind: "solo-draft", region, project: "p" })).toEqual({
    region,
    project: "p",
  });
  for (const params of [
    { kind: "solo-draft", region: "buzz.solo" },
    { kind: "solo-draft", region: "buzz.region:Example:tasks" },
    { kind: "solo-draft", region: 1 },
    {
      kind: "solo-draft",
      region,
      linked: "00000000-0000-4000-8000-000000000000",
    },
  ])
    expect(soloDraft(params)).toBeUndefined();
});
it("keeps a region lead draft only with its region and workspace", () => {
  const region = "buzz.region:example:tasks";
  expect(
    soloDraft({ kind: "solo-draft", region, project: "p", lead: true }),
  ).toEqual({ region, project: "p", lead: true });
  for (const params of [
    { kind: "solo-draft", region, lead: true },
    { kind: "solo-draft", project: "p", lead: true },
    { kind: "solo-draft", region, project: "p", lead: false },
  ])
    expect(soloDraft(params)).toBeUndefined();
});
