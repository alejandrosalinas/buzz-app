import { expect, it } from "vitest";
import type { ChannelSummary } from "./contracts";
import { lifecycleOffer, ownerEvidence } from "./channel-lifecycle-protocol";

const viewer = "a".repeat(64),
  other = "b".repeat(64);
const channel = (overrides: Partial<ChannelSummary> = {}): ChannelSummary => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Fixture",
  channelType: "stream",
  viewerRole: "member",
  members: [viewer, other],
  owners: [other],
  ...overrides,
});
const offered = (summary: ChannelSummary, agentOwner = false) => {
  const offer = lifecycleOffer(summary, viewer, agentOwner);
  return (
    offer &&
    (
      [
        "canLeave",
        "canArchive",
        "canUnarchive",
        "canDelete",
        "canHide",
      ] as const
    )
      .filter((key) => offer[key])
      .map((key) => key.slice(3).toLowerCase())
  );
};

it.each([
  ["member", {}, false, ["leave"]],
  ["guest", { viewerRole: "guest", readOnly: true }, false, ["leave"]],
  ["admin", { viewerRole: "admin" }, false, ["leave", "archive"]],
  [
    "archived admin",
    { viewerRole: "admin", archived: true },
    false,
    ["leave", "unarchive"],
  ],
  [
    "co-owner",
    { viewerRole: "owner", owners: [viewer, other] },
    false,
    ["leave", "archive", "delete"],
  ],
  [
    "last owner",
    { viewerRole: "owner", owners: [viewer] },
    false,
    ["archive", "delete"],
  ],
  ["owner-agent's human", {}, true, ["leave", "archive", "delete"]],
  [
    "archived owner-agent's human",
    { archived: true },
    true,
    ["leave", "unarchive"],
  ],
  ["Solo chat member", { channelType: "solo" }, false, ["leave"]],
  ["DM", { channelType: "dm", owners: [] }, false, ["hide"]],
] as const)("offers a %s %j", (_, overrides, agentOwner, actions) => {
  expect(
    offered(channel(overrides as Partial<ChannelSummary>), agentOwner),
  ).toEqual(actions);
});

it("explains why the last owner cannot leave and maps Solo chats to streams", () => {
  expect(
    lifecycleOffer(
      channel({ viewerRole: "owner", owners: [viewer] }),
      viewer,
      false,
    )?.leaveReason,
  ).toBe("Transfer ownership before leaving the channel.");
  expect(
    lifecycleOffer(channel({ channelType: "solo" }), viewer, false)
      ?.channelType,
  ).toBe("stream");
});

it.each([
  ["unknown type", { channelType: undefined }],
  ["unknown roster", { owners: undefined }],
  ["nonmember", { members: [other] }],
  ["id the lifecycle protocol rejects", { id: "beta" }],
  ["restored cached membership", { viewerRole: "owner", cached: true }],
  ["revoked membership", { viewerRole: undefined, readOnly: true }],
] as const)("offers nothing for a %s", (_, overrides) => {
  expect(
    lifecycleOffer(channel(overrides as Partial<ChannelSummary>), viewer, true),
  ).toBeUndefined();
});

it.each([
  ["member", {}, [other]],
  ["admin", { viewerRole: "admin" }, [other]],
  ["archived admin", { viewerRole: "admin", archived: true }, []],
  ["owner", { viewerRole: "owner", owners: [viewer] }, []],
  ["DM member", { channelType: "dm" }, []],
  ["cached member", { cached: true }, []],
  ["nonmember", { members: [other] }, []],
] as const)(
  "asks for owner-agent evidence only where it can add actions: %s",
  (_, overrides, owners) => {
    expect(
      ownerEvidence(channel(overrides as Partial<ChannelSummary>), viewer),
    ).toEqual(owners);
  },
);
