import { workspaceDirectories } from "../../features/solo/workspace";

const MAX_FOLDERS = 20;
const ABSOLUTE = /^(?:\/|~(?:[\\/]|$)|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/])/;
const PARENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/** The chat Canvas's project folders that are absolute or under home, in
 * either platform's notation, never reaching up with `..`. */
export function projectFolders(canvas: string | undefined): string[] {
  return workspaceDirectories(canvas ?? "")
    .filter(
      (folder) =>
        ABSOLUTE.test(folder) && !PARENT.test(folder) && !folder.includes("\0"),
    )
    .slice(0, MAX_FOLDERS);
}

/** `folder` for git's `-C`. Git always starts in the home folder, which
 * exists on every platform: spawning there never creates the folder. */
export function gitDirectory(folder: string): string {
  const home = /^~(?:[\\/](.*))?$/.exec(folder);
  return home ? home[1] || "." : folder;
}

export const baseName = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
