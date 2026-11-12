// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { readView, writeView } from "../../shared/view-state";
import { regionDraftKey, regionStartKey } from "./solo-navigation";
import { createSoloRegionFixture } from "./solo-navigation-testing";

const label = "buzz.region:example:work";
const cleanup: (() => unknown)[] = [];
beforeEach(() => localStorage.clear());
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
function fixture() {
  const h = createSoloRegionFixture();
  cleanup.push(h.dispose);
  return h;
}

it("opens New chat for its region, and only that region reads and forgets how its chats started", async () => {
  const h = fixture();
  const source = await h.register();
  const other = await h.register({ id: "other" });
  const binding = source.binding();
  const opened = () => h.navigator.snapshot().attempt.entry.target;
  source.handle.openDraft(binding);
  expect(opened()).toMatchObject({
    kind: "page",
    pluginId: "buzz.channels",
    route: { params: { kind: "solo-draft", region: label } },
  });
  // As New chat in a workspace: switched-away instructions don't carry over.
  const key = regionDraftKey(label, "work");
  writeView(h.scope, `${key}:new-project`, "elsewhere");
  writeView(h.scope, `${key}:settings`, { name: "Kept", canvas: "Other" });
  source.handle.openDraft(binding, { workspace: "work" });
  expect(opened()).toMatchObject({
    route: { params: { kind: "solo-draft", region: label, project: "work" } },
  });
  expect(readView(h.scope, `${key}:new-project`, "unset")).toBe("unset");
  expect(readView(h.scope, `${key}:settings`, null)).toEqual({ name: "Kept" });
  expect(() => source.handle.openDraft(binding, { workspace: "" })).toThrow(
    "Invalid workspace",
  );

  writeView(h.scope, regionStartKey("chat-1"), {
    region: label,
    workspace: "work",
  });
  writeView(h.scope, regionStartKey("chat-2"), { region: label });
  expect(source.handle.started(binding, "chat-1")).toEqual({
    workspace: "work",
  });
  expect(source.handle.started(binding, "chat-2")).toEqual({});
  expect(source.handle.started(binding, "chat-3")).toBeUndefined();
  // Another region's source neither reads nor clears it.
  expect(other.handle.started(other.binding(), "chat-1")).toBeUndefined();
  other.handle.forget(other.binding(), "chat-1");
  // It outlives the binding, as across a restart.
  h.reconnect();
  const next = source.binding();
  expect(next.incarnation).not.toBe(binding.incarnation);
  expect(() => source.handle.started(binding, "chat-1")).toThrow("ended");
  expect(source.handle.started(next, "chat-1")).toEqual({ workspace: "work" });
  source.handle.forget(next, "chat-1");
  expect(source.handle.started(next, "chat-1")).toBeUndefined();
  expect(source.handle.started(next, "chat-2")).toEqual({});
});

it("names a region's draft owner only while its source is running and ready", async () => {
  const h = fixture();
  expect(h.service.draftRegion(label)).toBeUndefined();
  const source = await h.register();
  expect(h.service.draftRegion(label)).toMatchObject({
    binding: source.binding(),
    source: { id: "work" },
  });
  expect(h.service.draftRegion("buzz.region:example:other")).toBeUndefined();
  source.update({ status: "loading", binding: source.binding(), revision: 2 });
  expect(h.service.draftRegion(label)).toBeUndefined();
  source.update({ status: "ready", binding: source.binding(), revision: 3 });
  await source.fiber.dispose();
  expect(h.service.draftRegion(label)).toBeUndefined();
});

it("opens a workspace's lead draft only in that workspace and returns the lead with its start", async () => {
  const h = fixture();
  const source = await h.register();
  const binding = source.binding();
  source.handle.openDraft(binding, { workspace: "work", lead: true });
  expect(h.navigator.snapshot().attempt.entry.target).toMatchObject({
    route: {
      params: {
        kind: "solo-draft",
        region: label,
        project: "work",
        lead: true,
      },
    },
  });
  expect(() => source.handle.openDraft(binding, { lead: true })).toThrow(
    "Invalid workspace",
  );
  writeView(h.scope, regionStartKey("chat"), {
    region: label,
    workspace: "work",
    lead: true,
  });
  expect(source.handle.started(binding, "chat")).toEqual({
    workspace: "work",
    lead: true,
  });
});
