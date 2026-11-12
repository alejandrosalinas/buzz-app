import type { Context } from "@deepseek-ai/cordis";
import type {} from "./status";
import type {} from "./api";
import { bundledContribution, isBundledOwner } from "./provenance";

export type Contribution<T> = Readonly<
  T & { key: string; pluginId: string; revision: string }
>;
/** How strongly a contribution claims a target: lower wins, default 0. Bands by
 * convention: -10 specialises a known plugin, 0 default/specific, 100 catch-all. */
export type MatchOrder<Target = string> = number | ((target: Target) => number);
/** Among active matches, the lowest order for this target wins; ties fall to the
 * contribution key so activation or re-enable order never decides. A throwing
 * matcher is skipped; a throwing or non-finite order counts as the default. */
export function resolveMatch<
  T extends {
    matches(target: Target): boolean;
    order?: MatchOrder<Target> | undefined;
  },
  Target = string,
>(entries: readonly Contribution<T>[], target: Target) {
  const orderOf = (entry: T) => {
    try {
      const order =
        typeof entry.order === "function" ? entry.order(target) : entry.order;
      return Number.isFinite(order) ? (order as number) : 0;
    } catch {
      return 0;
    }
  };
  let winner: Contribution<T> | undefined;
  let best = 0;
  for (const entry of entries) {
    try {
      if (!entry.matches(target)) continue;
    } catch {
      continue;
    }
    const order = orderOf(entry);
    if (!winner || order < best || (order === best && entry.key < winner.key)) {
      winner = entry;
      best = order;
    }
  }
  return winner;
}
// Pages and panels share these ownership rules: namespace IDs by plugin, expose
// only active revisions, and remove registrations when their Cordis scope ends.
export function createContributions<T extends { id: string }>(root: Context) {
  let entries: readonly Contribution<T>[] = [];
  let ready: readonly Contribution<T>[] = [];
  const listeners = new Set<() => void>();
  const publish = () => {
    const next = entries.filter((entry) =>
      root.pluginStatus.isActive(entry.pluginId, entry.revision),
    );
    if (
      next.length === ready.length &&
      next.every((entry, i) => entry === ready[i])
    )
      return;
    ready = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  root.effect(() => root.pluginStatus.subscribe(publish));
  return {
    snapshot: () => ready,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Returns a function that removes it before its scope ends. */
    register(ctx: Context, value: T): () => void {
      const owner = ctx.pluginOwner;
      if (!owner)
        throw new Error(
          "Contributions must be registered by an installed plugin",
        );
      const key = `${owner.id}/${value.id}`;
      if (entries.some((entry) => entry.key === key))
        throw new Error(`Contribution already registered: ${key}`);
      const entry = Object.freeze({
        ...value,
        key,
        pluginId: owner.id,
        revision: owner.revision,
      });
      if (isBundledOwner(owner)) bundledContribution(entry);
      const remove = ctx.effect(() => {
        entries = [...entries, entry];
        publish();
        return () => {
          entries = entries.filter((item) => item !== entry);
          publish();
        };
      }, key);
      return () => void remove();
    },
  };
}
