import { describe, expect, it } from "vitest";

import { communityName } from "./community-name";

describe("communityName", () => {
  it("shortens a <name>.communities.<domain> host on any domain", () => {
    expect(communityName(undefined, "foo.communities.buzz.xyz")).toBe("foo");
    expect(communityName(undefined, "foo.communities.example.org")).toBe("foo");
  });

  it("shows other hosts in full", () => {
    expect(communityName(undefined, "communities.buzz.xyz")).toBe(
      "communities.buzz.xyz",
    );
    expect(communityName(undefined, "a.b.communities.buzz.xyz")).toBe(
      "a.b.communities.buzz.xyz",
    );
  });

  it("keeps a custom name and ignores placeholder names", () => {
    const host = "foo.communities.example.org";
    expect(communityName("Garden Club", host)).toBe("Garden Club");
    expect(communityName("Buzz Relay", host)).toBe("foo");
    expect(communityName(host, host)).toBe("foo");
    expect(communityName("  ", host)).toBe("foo");
  });
});
