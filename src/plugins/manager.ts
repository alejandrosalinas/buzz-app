import { createPluginStorage, type PluginStorage } from "./storage";
import * as React from "react";
import { PluginRuntime } from "./runtime";
import type { Context } from "@deepseek-ai/cordis";
import type { PluginManifest, PluginModule } from "./api";
import { createModuleLoader } from "./modules";
import { withTimeout } from "./timeout";
import { createPluginRequests } from "./requests";
import { providePluginManagement } from "./review-access";
import type {
  StorageResult,
  ConfigurationState,
  ManagementAction,
  PluginInfo,
} from "./types";

export function canRetryPlugin(
  plugin: PluginInfo | undefined,
  activation: ReturnType<PluginRuntime["snapshot"]>[string] | undefined,
  externalPluginsPaused: boolean,
) {
  return (
    !!plugin?.enabled &&
    !plugin.error &&
    !(externalPluginsPaused && plugin.source === "external") &&
    activation?.status === "failed" &&
    activation.revision === plugin.revision
  );
}

export type BundledPlugin = {
  manifest: PluginManifest;
  module: PluginModule;
  enabledByDefault?: boolean;
};

// One configuration observer drives activation, whether or not Settings is mounted.
export function createPluginManager(
  ctx: Context,
  {
    bundled,
    builtIn = [],
    storage = createPluginStorage(() =>
      bundled.map(({ manifest, enabledByDefault = true }) => ({
        manifest,
        source: "bundled",
        enabled: enabledByDefault,
        revision: "bundled",
        previous: null,
        reloadable: false,
        error: null,
      })),
    ),
  }: {
    bundled: readonly BundledPlugin[];
    /** Host-owned contributions, independent of optional-plugin storage. */
    builtIn?: readonly BundledPlugin[];
    storage?: PluginStorage | undefined;
  },
) {
  ctx.provide("react", React);
  const builtInPlugins: PluginInfo[] = builtIn.map(({ manifest }) => ({
    manifest,
    source: "bundled",
    enabled: true,
    revision: "bundled",
    previous: null,
    reloadable: false,
    error: null,
  }));
  const builtInIds = new Set(builtIn.map(({ manifest }) => manifest.id));
  let configuration: ConfigurationState = { status: "loading" };
  const runtime = new PluginRuntime(
    ctx,
    createModuleLoader(
      Object.fromEntries(
        [...bundled, ...builtIn].map(({ manifest, module }) => [
          manifest.id,
          module,
        ]),
      ),
      storage.readModule,
    ),
    undefined,
    // Reading, or retrying a read that failed: recovery the user must act on
    // is settled.
    () =>
      configuration.status === "loading" ||
      (configuration.status === "recovery" && !configuration.canReset),
  );
  let busy = false;
  let catalogPending = false;
  let error: string | null = null;
  let refreshError: string | null = null;
  let closed = false;
  let changes = 0;
  let timer: ReturnType<typeof setTimeout>;
  const listeners = new Set<() => void>();
  const read = () => ({
    configuration,
    activation: runtime.snapshot(),
    busy,
    error,
    refreshError,
  });
  let snapshot = read();
  const publish = () => {
    if (closed) return;
    snapshot = read();
    for (const listener of listeners) listener();
  };
  const unsubscribe = runtime.subscribe(publish);

  function accept(next: StorageResult) {
    if (JSON.stringify(configuration) === JSON.stringify(next) && !refreshError)
      return;
    configuration = next;
    refreshError = null;
    runtime.reconcile(desiredPlugins());
    publish();
  }
  function desiredPlugins() {
    const current = configuration;
    const optional =
      current.status === "ready"
        ? current.catalog.plugins.filter(
            (plugin) =>
              plugin.enabled &&
              !plugin.error &&
              !builtInIds.has(plugin.manifest.id) &&
              !(current.externalPluginsPaused && plugin.source === "external"),
          )
        : [];
    return [...builtInPlugins, ...optional];
  }
  async function getCatalog() {
    if (catalogPending)
      throw new Error("Plugin catalog read is still in progress");
    catalogPending = true;
    try {
      return await storage.getCatalog();
    } finally {
      catalogPending = false;
    }
  }
  async function refresh() {
    const before = changes;
    try {
      if (busy || catalogPending) return;
      const next = await withTimeout(
        getCatalog(),
        "Plugin storage did not respond within 10 seconds",
      );
      if (!closed && before === changes) accept(next);
    } catch (reason) {
      if (!closed && before === changes) {
        if (configuration.status === "ready") {
          refreshError = String(reason);
          publish();
        } else
          accept({
            status: "recovery",
            reason: String(reason),
            canReset: false,
          });
      }
    } finally {
      if (!closed) timer = setTimeout(() => void refresh(), 1000);
    }
  }
  async function update(
    operation: () => Promise<StorageResult>,
    timeoutMs = 10_000,
    waitForSettlement = false,
  ) {
    if (busy || closed) return false;
    busy = true;
    changes++;
    error = null;
    publish();
    // Ordinary edits may end the caller's wait, never the underlying native operation.
    let settled = false;
    const pending = (async () => {
      try {
        return await operation();
      } finally {
        settled = true;
      }
    })();
    const finish = () => {
      changes++;
      busy = false;
      publish();
    };
    try {
      let next: StorageResult;
      try {
        next = await withTimeout(
          pending,
          `Plugin storage did not respond within ${timeoutMs / 1000} seconds`,
          timeoutMs,
        );
      } catch (reason) {
        if (!waitForSettlement || settled) throw reason;
        if (!closed) {
          error = String(reason);
          publish();
        }
        // Import reviews own a confirmed operation until native actually settles.
        next = await pending;
      }
      if (!closed) {
        error = null;
        accept(next);
      }
      return !closed;
    } catch (reason) {
      if (!closed) {
        error = String(reason);
        publish();
      }
      return false;
    } finally {
      if (settled) finish();
      else void pending.then(finish, finish);
    }
  }
  const change = (action: ManagementAction, id: string) =>
    update(() => storage.changePlugin(action, id));
  const requests = createPluginRequests({
    catalog: () =>
      configuration.status === "ready" ? configuration.catalog : undefined,
    imports: storage.imports,
    change,
    error: () => error,
    managed: () =>
      configuration.status === "ready" ? configuration.managed : undefined,
  });
  ctx.provide("pluginRequests", requests);
  runtime.reconcile(desiredPlugins());
  void refresh();
  const manager = {
    snapshot: () => snapshot,
    startup: () => configuration.status,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    imports: storage.imports,
    installImport: (token: string, path: string) =>
      update(
        () => {
          if (!storage.imports)
            throw new Error("Plugin imports require the desktop app");
          return storage.imports.install(token, path);
        },
        10_000,
        true,
      ),
    change,
    requests,
    reload: (id: string) => update(() => storage.reloadPlugin(id), 120_000),
    retryPlugin: (id: string) => {
      if (closed || busy) return false;
      const desired = desiredPlugins();
      const plugin = desired.find((item) => item.manifest.id === id);
      const activation = runtime.snapshot()[id];
      if (!canRetryPlugin(plugin, activation, false)) return false;
      runtime.reconcile(desired, id);
      return true;
    },
    retry: () => update(getCatalog),
    // The native fetch gives up after 30 seconds.
    refreshManaged: () => update(storage.refreshManaged ?? getCatalog, 45_000),
    recover: () => update(storage.recoverSettings),
    dismissError: () => {
      error = null;
      publish();
    },
    async dispose() {
      closed = true;
      clearTimeout(timer);
      unsubscribe();
      listeners.clear();
      await runtime.dispose();
    },
  };
  providePluginManagement(ctx, manager);
  return manager;
}
export type PluginManager = ReturnType<typeof createPluginManager>;
