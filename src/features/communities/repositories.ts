import { communityDestination } from "./destination";
import { splitPartition } from "../relay/partition";

export const DEFAULT_REPOSITORIES_FOLDER = "~/.buzz/REPOS";
export function repositoriesKey(community: string, viewer: string) {
  if (!/^[a-f0-9]{64}$/.test(viewer)) throw new Error("Account unavailable");
  return `buzz-community-repositories.v1:${JSON.stringify([communityDestination(community).url, viewer])}`;
}

/** Paths are data, never shell fragments or prompt markup. Native save also checks the directory. */
export function repositoriesPath(value: string) {
  const path = value.trim();
  if (
    path.length > 2048 ||
    [...path].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    (path && !/^(?:~$|\/|~\/|[a-z]:[\\/]|\\\\)/i.test(path))
  )
    throw new Error("Choose an absolute folder path or a path under ~/.");
  return path;
}

export function readRepositoriesFolder(community: string, viewer: string) {
  const value = localStorage.getItem(repositoriesKey(community, viewer));
  return value === null ? "" : repositoriesPath(value);
}

/** Required readback; never reports a failed or ignored write as saved. */
export function saveRepositoriesFolder(
  community: string,
  viewer: string,
  value: string,
) {
  const path = repositoriesPath(value);
  const key = repositoriesKey(community, viewer);
  try {
    if (path) localStorage.setItem(key, path);
    else localStorage.removeItem(key);
    if (localStorage.getItem(key) !== (path || null))
      throw new Error("Not retained");
  } catch {
    throw new Error(
      "Couldn’t save the repositories folder on this device. Try again.",
    );
  }
  return path;
}

export type RepositoryFolder = Readonly<{
  name: string;
  path: string;
  displayPath: string;
}>;

/** The folder `repositoryFolders` lists for `partition` now. */
export function repositoriesFolder(partition: string) {
  const scope = splitPartition(partition);
  if (!scope)
    throw new Error(
      "Choose a connected community and account before listing folders.",
    );
  return (
    readRepositoriesFolder(scope.communityOrigin, scope.viewer) ||
    DEFAULT_REPOSITORIES_FOLDER
  );
}

/** The immediate folders of `partition`'s configured repositories folder, or
 * of the default one. Native code checks only the folder `list` is given; the
 * caller's community and account choose it. Rejects if `signal` aborts or the
 * preference changes meanwhile. Never creates the folder. */
export async function repositoryFolders(
  partition: string,
  signal: AbortSignal,
  list: (path: string) => Promise<readonly RepositoryFolder[]>,
) {
  const path = repositoriesFolder(partition);
  signal.throwIfAborted();
  // A stalled listing must not hold the caller past its signal.
  let abort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  let rows: readonly RepositoryFolder[];
  try {
    rows = await Promise.race([list(path), aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
  signal.throwIfAborted();
  if (repositoriesFolder(partition) !== path)
    throw new Error("The repositories folder changed. Try again.");
  return rows;
}

/** Captured agent community/account, never the selected community. No filesystem changes. */
export function repositoriesContext(partition: string | undefined) {
  const scope = partition && splitPartition(partition);
  if (!scope) return "";
  // An unreadable configured preference must not silently direct work to another folder.
  const folder = readRepositoriesFolder(scope.communityOrigin, scope.viewer);
  if (!folder)
    return "<community-repositories>\nUse REPOS in your own workspace for source checkouts. This restores the default and replaces any earlier community repositories folder. A chat’s explicit project folders take precedence.\n</community-repositories>";
  const quoted = JSON.stringify(folder)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
  return `<community-repositories>\nThe repositories folder for this community on this device is ${quoted} (a literal path). Use existing source checkouts there before cloning. This replaces the REPOS/ source-checkout location in the workspace layout, not your own workspace for notes. A chat’s explicit project folders take precedence. Do not move files or repoint symlinks. This is a working location, not an access restriction.\n</community-repositories>`;
}
