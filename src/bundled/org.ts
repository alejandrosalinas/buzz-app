// Plugins an organization bundles into its own build of Buzz; none in
// open-source builds. Packagers may replace this file and org.json at build
// time. org.json lists each plugin's manifest and whether it starts on; the
// desktop app's native side reads it too, so both agree on what is bundled
// and which network origins each may reach. This file gives each one's code,
// keyed by manifest id, so a whole plugin fits in these two files and needs
// no README. See docs/plugin-architecture.md, "Organization plugins".
import type { PluginManifest, PluginModule } from "../plugins/api";
import type { BundledPlugin } from "../plugins/manager";
import listed from "./org.json";

type Listed = Readonly<{ manifest: PluginManifest; enabledByDefault: boolean }>;

/** Each listed plugin's code, by manifest id. */
const modules: Readonly<Record<string, PluginModule>> = {};

/** org.json's plugins with their code; one without code is left out. */
export const orgPlugins: readonly BundledPlugin[] = (
  listed as unknown as readonly Listed[]
).flatMap(({ manifest, enabledByDefault }) => {
  const module = modules[manifest.id];
  if (module) return [{ manifest, module, enabledByDefault }];
  console.error(`Organization plugin ${manifest.id} has no code in org.ts`);
  return [];
});
