// Mounted tests exercise composer lifecycle against a fallible storage boundary.
// The two-page browser regression owns the real IDB transaction/notification contract.
import {
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";
import type { ModelPicksTransaction } from "./solo-model-picks-storage";

const versions = new Map<
  string,
  { revision: string | null; version: string }
>();

export async function transactModelPicks<T>(
  scope: string,
  _keys: readonly string[],
  change: (transaction: ModelPicksTransaction) => T,
) {
  const version = (key: string) => {
    const id = JSON.stringify([scope, key]);
    const revision = viewRevision(scope, key);
    if (revision === undefined)
      throw new Error("Saved choices are unreadable.");
    let saved = versions.get(id);
    if (!saved || saved.revision !== revision) {
      saved = { revision, version: crypto.randomUUID() };
      versions.set(id, saved);
    }
    return saved.version;
  };
  return change({
    revision(key) {
      const revision = viewRevision(scope, key);
      if (revision === undefined)
        throw new Error("Saved choices are unreadable.");
      return revision;
    },
    version,
    write(key, value) {
      if (!writeView(scope, key, value))
        throw new Error("Choices were not saved.");
      const receipt = crypto.randomUUID();
      versions.set(JSON.stringify([scope, key]), {
        revision: viewRevision(scope, key) ?? null,
        version: receipt,
      });
      return receipt;
    },
  });
}

export function subscribeModelPicks(scope: string, listener: () => void) {
  const snapshot = () => {
    try {
      return JSON.stringify(
        Object.keys(localStorage)
          .filter((key) => {
            if (!key.startsWith("buzz-view.v1:")) return false;
            const pair = JSON.parse(key.slice("buzz-view.v1:".length));
            return pair[0] === scope && pair[1].startsWith("solo:model-picks:");
          })
          .sort()
          .map((key) => [key, localStorage.getItem(key)]),
      );
    } catch {
      return undefined;
    }
  };
  let before = snapshot();
  return subscribeView(
    scope,
    () => {
      const after = snapshot();
      if (after === before) return;
      before = after;
      listener();
    },
    (key) => key.startsWith("solo:model-picks:"),
  );
}
export const publishModelPicks = (_scope: string) => {};
export async function purgeSoloModelPicks(_scope: string) {}
