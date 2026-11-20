import { expect, it } from "vitest";
import { relayNotice, withoutRelayNotice } from "./relayed-from";

it("removes only the signed original's notice from the shown text", () => {
  const notice = relayNotice("@Juno From Zerk (relayed)\n\nRebase on main");
  expect(notice).toBe("@Juno From Zerk (relayed)");
  expect(
    withoutRelayNotice("@Juno From Zerk (relayed)\n\nRebase", notice),
  ).toBe("Rebase");
  // Attachment markup removed after the notice leaves nothing else to show.
  expect(withoutRelayNotice("@Juno From Zerk (relayed)", notice)).toBe("");
  // An edit that replaced the notice keeps every paragraph.
  expect(withoutRelayNotice("First\n\nSecond", notice)).toBe("First\n\nSecond");
  expect(relayNotice("No blank line")).toBeUndefined();
  expect(withoutRelayNotice("First\n\nSecond", undefined)).toBe(
    "First\n\nSecond",
  );
});

it("keeps an edit that only begins like the notice", () => {
  expect(withoutRelayNotice("Build status is green.", "Build status")).toBe(
    "Build status is green.",
  );
  expect(
    withoutRelayNotice("Build status, corrected\n\nGreen", "Build status"),
  ).toBe("Build status, corrected\n\nGreen");
});

it("removes a notice whose mention an edit bound to a profile link", () => {
  const notice = "@Juno From Zerk (relayed)";
  expect(
    withoutRelayNotice(
      "[@Juno](nostr:npub1example) From Zerk (relayed)\n\nRebase",
      notice,
    ),
  ).toBe("Rebase");
});
