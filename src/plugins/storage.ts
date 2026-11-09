import { migrateAgentFlag } from "./migrate-agent-flag";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  Catalog,
  StorageResult,
  ManagementAction,
  PluginImports,
} from "./types";

export const desktop = isTauri();
const storageKey = "buzzodz.plugins.v1";

export function createPluginStorage(bundledCatalog: () => Catalog["plugins"]) {
  function webCatalog(reset = false): StorageResult {
    const catalog: Catalog = {
      profile: "browser",
      location: "This browser",
      plugins: bundledCatalog(),
    };
    try {
      const raw = localStorage.getItem(storageKey);
      const existing =
        !reset &&
        (raw !== null ||
          Object.keys(localStorage).some((key) =>
            /^buzz-client\.v1:[a-f0-9]{64}$/.test(key),
          ));
      const flags: Record<string, boolean> = {};
      if (raw !== null && !reset) {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== "object" || !("version" in value))
          throw new Error("Invalid browser plugin settings");
        if (
          value.version === 1 &&
          "enabled" in value &&
          typeof value.enabled === "boolean"
        ) {
          // This retired format controlled only the removed Welcome demo.
        } else if (
          (value.version === 2 || value.version === 3) &&
          "enabled" in value &&
          value.enabled &&
          typeof value.enabled === "object" &&
          !Array.isArray(value.enabled) &&
          Object.values(value.enabled).every(
            (flag) => typeof flag === "boolean",
          )
        ) {
          Object.assign(flags, value.enabled);
          if (value.version === 2) {
            migrateAgentFlag(flags);
          }
        } else throw new Error("Invalid browser plugin settings");
      }
      for (const plugin of catalog.plugins) {
        const id = plugin.manifest.id;
        flags[id] ??=
          plugin.enabled ||
          (existing && (id === "buzz.reminders" || id === "buzz.workflows"));
        plugin.enabled = flags[id];
      }
      const saved = JSON.stringify({ version: 3, enabled: flags });
      if (saved !== raw) localStorage.setItem(storageKey, saved);
    } catch (error) {
      return { status: "recovery", reason: String(error), canReset: true };
    }
    // Channels is required even when an older installation saved it disabled.
    for (const plugin of catalog.plugins)
      if (plugin.manifest.id === "buzz.channels") plugin.enabled = true;
    return { status: "ready", catalog, externalPluginsPaused: false };
  }
  async function getCatalog(): Promise<StorageResult> {
    return desktop ? invoke("plugin_catalog") : webCatalog();
  }
  async function changePlugin(
    action: ManagementAction,
    id: string,
  ): Promise<StorageResult> {
    if (desktop) return invoke("plugin_change", { action, id });
    const result = webCatalog();
    if (result.status === "recovery")
      throw new Error("Recover browser settings before editing them");
    const { catalog } = result;
    if (
      !catalog.plugins.some((p) => p.manifest.id === id) ||
      (action !== "enable" && action !== "disable")
    )
      throw new Error("Bundled plugins can only be enabled or disabled");
    if (id === "buzz.channels" && action === "disable")
      throw new Error("Channels is required and cannot be disabled");
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 3,
        enabled: Object.fromEntries(
          catalog.plugins.map((plugin) => [
            plugin.manifest.id,
            plugin.manifest.id === id ? action === "enable" : plugin.enabled,
          ]),
        ),
      }),
    );
    return webCatalog();
  }
  async function recoverSettings(): Promise<StorageResult> {
    if (desktop) return invoke("plugin_recover");
    const raw = localStorage.getItem(storageKey);
    if (raw !== null)
      localStorage.setItem(`${storageKey}.backup.${Date.now()}`, raw);
    return webCatalog(true);
  }
  async function readModule(id: string, revision: string): Promise<string> {
    if (!desktop) throw new Error("Local plugins require the desktop app");
    return invoke("plugin_module", { id, revision });
  }
  async function reloadPlugin(id: string): Promise<StorageResult> {
    if (!desktop) throw new Error("Plugin reload requires the desktop app");
    return invoke("plugin_reload", { id });
  }

  const imports: PluginImports | undefined = desktop
    ? {
        folder: () => invoke("plugin_import_folder"),
        checkFolder: (id) => invoke("plugin_update_check", { id }),
        previewFolder: (id) => invoke("plugin_update_preview", { id }),
        files: (source, files) =>
          invoke("plugin_import_folder", { upload: { source, files } }),
        git: (repository, reference, authorization, commit) =>
          invoke("plugin_import_git", {
            repository,
            reference,
            authorization,
            commit,
          }),
        checkGit: (repository, reference, authorization) =>
          invoke("plugin_import_git", {
            repository,
            reference,
            authorization,
            checkOnly: true,
          }),
        url: (url, sha256) => invoke("plugin_import_url", { url, sha256 }),
        install: (token, path) =>
          invoke("plugin_import_install", { token, path }),
        discard: (token) => invoke("plugin_import_discard", { token }),
      }
    : undefined;
  return {
    getCatalog,
    changePlugin,
    recoverSettings,
    readModule,
    reloadPlugin,
    imports,
  };
}
export type PluginStorage = Omit<
  ReturnType<typeof createPluginStorage>,
  "imports"
> & {
  imports?: PluginImports | undefined;
};
