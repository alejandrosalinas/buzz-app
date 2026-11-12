import type { GitScope } from "./types";

/** Trailing arguments for the Git import calls, empty when the whole repository tip is wanted. */
export const gitScope = (
  commit: string | undefined,
  path: string | undefined,
): [GitScope] | [] => {
  const folder = path === "." ? undefined : path;
  return commit || folder ? [{ commit, path: folder }] : [];
};
