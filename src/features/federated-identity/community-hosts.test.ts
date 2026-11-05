import { expect, it } from "vitest";
import { coversCommunity, isBuiltInBuilderlab } from "./community-hosts";
import fixtures from "./community-hosts.fixtures.json";

// The same cases run through native's matchers (config.rs).
it.each(fixtures.communities)(
  "$hosts covers $relay: $covered",
  ({ hosts, relay, covered }) => {
    expect(coversCommunity(hosts, relay)).toBe(covered);
  },
);
it.each(fixtures.builtInBuilderlab)(
  "$url is the built-in Builderlab: $builtIn",
  ({ url, builtIn }) => {
    expect(isBuiltInBuilderlab(url)).toBe(builtIn);
  },
);
