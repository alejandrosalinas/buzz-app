import { expect, it } from "vitest";
import { createMemoryHistory } from "./history";
import { joinBeneath, withoutJoin, type OpenTarget } from "./targets";

const viewer = "a".repeat(64);
const page: OpenTarget = {
  version: 1,
  kind: "page",
  pluginId: "buzz.channels",
  pageId: "channels",
};
const settings: OpenTarget = {
  version: 1,
  kind: "settings",
  section: "block.builderlab/login",
};
const joinOver = (target: OpenTarget, visit: string): OpenTarget => ({
  ...target,
  join: { viewer, visit, community: "https://relay.example" },
});

it("closing a view also retires the join dialogs presented over it", () => {
  const history = createMemoryHistory(page);
  history.push(settings);
  history.push(joinOver(settings, "v1"));
  history.back();
  // Settings Close names Settings visits only.
  history.dismiss((target) => target.kind === "settings", page);
  expect(history.snapshot().current.target).toEqual(page);
  expect(history.snapshot().canGoForward).toBe(false);
});

it("closing a Settings card's routed visit retires a join opened from it", () => {
  const routed: OpenTarget = {
    ...settings,
    route: { version: 1, params: "create-community" },
  };
  const history = createMemoryHistory(page);
  history.push(routed);
  const shown = history.snapshot().current.id;
  // The join opened from the card keeps Settings without the card's route.
  history.push(joinOver(joinBeneath(routed), "v1"));
  history.back();
  history.dismiss([shown], page);
  expect(history.snapshot().current.target).toEqual(page);
  expect(history.snapshot().canGoForward).toBe(false);
});

it("closing exact visits by id retires joins over those visits", () => {
  const members: OpenTarget = {
    version: 1,
    kind: "conversation",
    scope: { viewer, communityOrigin: "https://relay.example" },
    channelId: "general",
    panel: "members",
  };
  const history = createMemoryHistory(page);
  history.push(members);
  const shown = history.snapshot().current.id;
  history.push(joinOver(members, "v1"));
  history.back();
  history.dismiss([shown], withoutJoin(members));
  expect(history.snapshot().canGoForward).toBe(false);
});

it("closing one join leaves another opening over the same view", () => {
  const history = createMemoryHistory(page);
  history.push(joinOver(page, "v1"));
  const first = history.snapshot().current.id;
  history.push(joinOver(page, "v2"));
  history.dismiss((target) => target.join?.visit === "v2", page);
  expect(history.snapshot().current.target).toEqual(page);
  history.back();
  expect(history.snapshot().current.id).toBe(first);
});
