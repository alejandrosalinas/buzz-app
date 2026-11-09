import { managedBy } from "./managed";
import type { PluginManager } from "./manager";
import type { ImportPreview, PluginInfo } from "./types";

export type GitUpdateSource = {
  repository: string;
  reference: string;
  path: string;
  commit?: string;
};
export type PluginUpdate = {
  id: string;
  source: GitUpdateSource;
  installedRevision: string;
  candidate?: ImportPreview["candidates"][number];
  error?: string;
};

export function pluginUpdateSource(plugins: PluginManager, id: string) {
  const { configuration } = plugins.snapshot();
  if (configuration.status !== "ready") return;
  const plugin = configuration.catalog.plugins.find(
    (p) => p.manifest.id === id,
  );
  const saved = plugin?.updateSource;
  if (
    plugin?.source !== "external" ||
    !plugin.manifest.updates ||
    !(plugin.updateChecks ?? plugin.manifest.updates.defaultEnabled) ||
    !saved ||
    !("repository" in saved)
  )
    return;
  const managed = managedBy(configuration.managed, id)?.entry;
  if (managed && "url" in managed) return;
  return managed
    ? {
        repository: managed.repository,
        reference: managed.reference,
        path: managed.path,
        commit: managed.commit,
      }
    : {
        repository: saved.repository,
        reference: saved.reference,
        path: saved.path,
      };
}

export const updateSourceKey = (source: GitUpdateSource) =>
  JSON.stringify([
    source.repository,
    source.reference,
    source.path,
    source.commit,
  ]);

export function createPluginUpdates(
  plugins: PluginManager,
  authorizeGit: (
    repository: string,
  ) => Promise<{ repository: string; token: string } | null>,
) {
  let updates: readonly PluginUpdate[] = [];
  let closed = false;
  let pending: Promise<number | undefined> | undefined;
  let retry = false;
  let lastCheck: number | undefined;
  let lastSources = "";
  const dismissed = new Set<string>();
  const listeners = new Set<() => void>();
  const key = (update: PluginUpdate) =>
    `${update.id}:${updateSourceKey(update.source)}:${update.candidate?.revision ?? update.error}`;
  const publish = (next: readonly PluginUpdate[]) => {
    if (closed) return;
    updates = next;
    for (const listener of listeners) listener();
  };
  function installed(id: string): PluginInfo | undefined {
    const { configuration } = plugins.snapshot();
    return configuration.status === "ready"
      ? configuration.catalog.plugins.find(
          (plugin) => plugin.manifest.id === id,
        )
      : undefined;
  }
  function current(update: PluginUpdate) {
    const source = pluginUpdateSource(plugins, update.id);
    return (
      installed(update.id)?.revision === update.installedRevision &&
      source &&
      updateSourceKey(source) === updateSourceKey(update.source)
    );
  }
  const prune = () => {
    const next = updates.filter(current);
    if (next.length !== updates.length) publish(next);
  };
  const unsubscribe = plugins.subscribe(prune);
  async function run(force: boolean) {
    if (closed || !plugins.imports) return;
    const { configuration } = plugins.snapshot();
    if (configuration.status !== "ready") return;
    const now = Date.now();
    const sources = JSON.stringify(
      configuration.catalog.plugins.map((plugin) => [
        plugin.manifest.id,
        pluginUpdateSource(plugins, plugin.manifest.id),
      ]),
    );
    if (
      !force &&
      sources === lastSources &&
      lastCheck !== undefined &&
      now - lastCheck < 3_600_000
    )
      return;
    lastCheck = now;
    lastSources = sources;
    const repositories = new Map<string, Promise<ImportPreview | null>>();
    const discover = (source: GitUpdateSource) => {
      const key = JSON.stringify([source.repository, source.reference]);
      let result = repositories.get(key);
      if (!result) {
        result = (async () => {
          const signed = await authorizeGit(source.repository);
          const live = plugins.snapshot().configuration;
          if (
            closed ||
            live.status !== "ready" ||
            !live.catalog.plugins.some((plugin) => {
              const current = pluginUpdateSource(plugins, plugin.manifest.id);
              return (
                current?.repository === source.repository &&
                current.reference === source.reference
              );
            })
          )
            return null;
          return (
            plugins.imports?.checkGit(
              signed?.repository ?? source.repository,
              source.reference,
              signed?.token,
            ) ?? null
          );
        })();
        repositories.set(key, result);
      }
      return result;
    };
    for (const plugin of configuration.catalog.plugins) {
      if (closed) return;
      const id = plugin.manifest.id;
      const source = pluginUpdateSource(plugins, id);
      if (!source) continue;
      const update: PluginUpdate = {
        id,
        source,
        installedRevision: plugin.revision,
      };
      try {
        const preview = await discover(source);
        if (!preview) throw new Error("No update source found. Try again.");
        if (
          source.commit &&
          preview.commit?.toLowerCase() !== source.commit.toLowerCase()
        )
          throw new Error(
            "The repository does not match the managed commit. Try again after the recommendation is corrected.",
          );
        const candidate = preview.candidates.find(
          (item) => item.manifest.id === id && item.path === source.path,
        );
        if (!candidate)
          throw new Error(
            "The saved repository has no plugin at its installed path.",
          );
        if (candidate.revision !== plugin.revision)
          update.candidate = candidate;
      } catch (reason) {
        update.error =
          reason instanceof Error ? reason.message : String(reason);
      }
      if (current(update))
        publish([
          ...updates.filter((item) => item.id !== id),
          ...(update.candidate || update.error ? [update] : []),
        ]);
    }
  }
  return {
    snapshot: () => updates,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hidden: (update: PluginUpdate) => dismissed.has(key(update)),
    later(update: PluginUpdate) {
      dismissed.add(key(update));
      publish([...updates]);
    },
    check(force = false): Promise<number | undefined> {
      retry ||= force;
      pending ??= (async () => {
        do {
          const forced = retry;
          retry = false;
          await run(forced);
        } while (retry && !closed);
        if (
          closed ||
          !plugins.imports ||
          plugins.snapshot().configuration.status !== "ready"
        )
          return;
        return Math.max(0, (lastCheck ?? Date.now()) + 3_600_000 - Date.now());
      })().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    dispose() {
      closed = true;
      unsubscribe();
      listeners.clear();
    },
  };
}
export type PluginUpdates = ReturnType<typeof createPluginUpdates>;
