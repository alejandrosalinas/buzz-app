import { invoke } from "@tauri-apps/api/core";
import { communityDestination, relayAddress } from "./destination";
import { enqueue } from "./known-communities";
import type { Communities } from "./service";

/** A community installed old Buzz saved, and the identity it saved it for. */
export type LegacyCommunity = { relayUrl: string; pubkey?: string };

const importedKey = (viewer: string) => `buzz-legacy-communities.v1:${viewer}`;
const imported = "1";

let importing = 0;
const importListeners = new Set<() => void>();
function setImporting(delta: number) {
  importing += delta;
  for (const listener of importListeners) listener();
}
/** Whether an import is reading, offering or adding a viewer's old
 * communities: a later app-level prompt waits for it, so it never opens over
 * this one's dialog and reads the communities it adds. */
export const legacyImportPending = () => importing > 0;
export function subscribeLegacyImport(listener: () => void) {
  importListeners.add(listener);
  return () => {
    importListeners.delete(listener);
  };
}

/** The removal addresses a pending import recorded for this viewer. */
function pendingRemovals(viewer: string): string[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(importedKey(viewer)) ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter((url): url is string => typeof url === "string")
      : [];
  } catch {
    return [];
  }
}

/** Offers the communities installed old Buzz saved for explicit import once,
 * through the same write a known-community list uses: saved without a
 * session or join, so a relay that is unreachable fails only when opened, as
 * any saved community does. Only the communities old Buzz recorded for this
 * viewer's identity are taken; one saved for another identity, or that
 * records none, is not. Existing memberships stay as they are; a relay
 * already saved, not a secure origin, or saved or queued for removal at any
 * point while this ran is skipped, and each added one is queued for upload
 * as a join would be. Account state cannot prove there were no acknowledged
 * removals, so every nonempty import requires consent, even with an empty
 * device record or pending sync. A per-viewer marker, written after declining
 * or once the list is saved,
 * keeps a later removal from being undone; until then it holds the removals
 * seen, so a failed read or save tries again on the next launch without
 * restoring them. The returned disposer also abandons a read still in
 * flight. */
export function importLegacyCommunities(
  communities: Pick<Communities, "snapshot" | "subscribe" | "applySync">,
  confirm: (origins: string[]) => Promise<boolean>,
  read = () => invoke<LegacyCommunity[]>("legacy_communities"),
) {
  let disposed = false;
  const attempted = new Set<string>();
  // Every membership each viewer held and removal it queued since this
  // started, or before a launch whose import did not finish, so one left
  // before or while the read was pending stays gone once its removal is
  // acknowledged. Removals not yet written are retried on each observation.
  const seen = new Map<
    string,
    { held: Set<string>; removed: Set<string>; saved: boolean }
  >();
  function observe() {
    const { viewer, memberships, sync } = communities.snapshot();
    if (!viewer)
      return {
        held: new Set<string>(),
        removed: new Set<string>(),
        saved: true,
      };
    const known = seen.get(viewer) ?? {
      held: new Set<string>(),
      removed: new Set(pendingRemovals(viewer)),
      saved: true,
    };
    seen.set(viewer, known);
    const before = known.removed.size;
    for (const { id } of memberships) known.held.add(id);
    for (const { url, removed } of sync.outbox)
      if (removed) known.removed.add(url);
    if (known.removed.size > before) known.saved = false;
    if (!known.saved) {
      try {
        if (localStorage.getItem(importedKey(viewer)) !== imported)
          localStorage.setItem(
            importedKey(viewer),
            JSON.stringify([...known.removed]),
          );
        known.saved = true;
      } catch (error) {
        console.warn("Couldn't save old Buzz's import progress", error);
      }
    }
    return known;
  }
  async function run() {
    observe();
    const { status, viewer } = communities.snapshot();
    if (disposed || status !== "ready" || !viewer || attempted.has(viewer))
      return;
    attempted.add(viewer);
    setImporting(1);
    try {
      if (localStorage.getItem(importedKey(viewer)) === imported) return;
      const saved = await read();
      const ready = communities.snapshot();
      if (disposed || ready.status !== "ready" || ready.viewer !== viewer)
        return;
      const { held, removed } = observe();
      const candidates = new Set<string>();
      for (const { relayUrl, pubkey } of saved) {
        if (pubkey !== viewer) continue;
        let id: string;
        try {
          id = communityDestination(relayUrl).id;
        } catch {
          continue;
        }
        const address = relayAddress(id);
        if (held.has(id) || removed.has(address)) continue;
        candidates.add(id);
      }
      const approved = candidates.size ? await confirm([...candidates]) : true;
      const current = communities.snapshot();
      if (disposed || current.status !== "ready" || current.viewer !== viewer)
        return;
      const latest = observe();
      const add = approved
        ? [...candidates].filter(
            (id) =>
              !latest.held.has(id) && !latest.removed.has(relayAddress(id)),
          )
        : [];
      let sync = current.sync;
      for (const id of add) sync = enqueue(sync, relayAddress(id), false);
      if (add.length) await communities.applySync(sync, add);
      localStorage.setItem(importedKey(viewer), imported);
    } catch (error) {
      console.warn("Couldn't add old Buzz's communities", error);
    } finally {
      setImporting(-1);
    }
  }
  const unsubscribe = communities.subscribe(() => void run());
  void run();
  return () => {
    disposed = true;
    unsubscribe();
  };
}
