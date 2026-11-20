import type { ManagedEntry, ManagedPlugins } from "./types";

/** Whether Settings lists the entry: a "manual" entry only offers updates. */
export function offeredManaged({ state, install }: ManagedEntry) {
  return install === "manual" ? state === "outdated" : state !== "current";
}

/** Recommendations that still need the user: not installed, or not at the pinned commit. */
export function pendingManaged(managed: ManagedPlugins | undefined) {
  return managed?.status === "ready"
    ? managed.plugins.filter(
        (entry) => entry.state !== "other" && offeredManaged(entry),
      )
    : [];
}

/** The recommendation an installed plugin came from, for its Managed by label. */
export function managedBy(
  managed: ManagedPlugins | undefined,
  id: string,
): { source: string; entry: ManagedEntry } | undefined {
  if (managed?.status !== "ready") return undefined;
  const entry = managed.plugins.find(
    (item) =>
      item.id === id && (item.state === "current" || item.state === "outdated"),
  );
  return entry && { source: managed.source, entry };
}

/** The Managed by label's source, noting a policy that keeps the plugin current. */
export function managedLabel(managed: ReturnType<typeof managedBy>) {
  return (
    managed &&
    `${managed.source}${managed.entry.update === "automatic" ? " · updates automatically" : ""}`
  );
}
