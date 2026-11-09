import { expect, it } from "vitest";
import { bundledPlugins } from ".";

it("keeps built-in conversation features out of the optional catalog", () => {
  const ids = bundledPlugins.map(({ manifest }) => manifest.id);
  expect(ids).not.toContain("buzz.emoji");
  expect(ids).not.toContain("buzz.mentions");
});

it("shares every bundled discovery tag between at least two plugins", () => {
  const plugins = new Map<string, string[]>();
  for (const { manifest } of bundledPlugins)
    for (const tag of manifest.discovery?.tags ?? [])
      plugins.set(tag, [...(plugins.get(tag) ?? []), manifest.id]);
  expect(plugins.size).toBeGreaterThan(0);
  for (const [tag, ids] of plugins) expect(ids.length, tag).toBeGreaterThan(1);
});

it("lists Codex before Claude, so new agents default to the harness without a key step", () => {
  const ids = bundledPlugins.map(({ manifest }) => manifest.id);
  expect(ids.indexOf("buzz.codex")).toBeGreaterThanOrEqual(0);
  expect(ids.indexOf("buzz.codex")).toBeLessThan(
    ids.indexOf("buzz.claude-code"),
  );
});
