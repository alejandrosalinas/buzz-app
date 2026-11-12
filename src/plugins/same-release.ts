import type { PluginRelease } from "./types";

// Adding a signature changes publisher metadata, not the artifact revision.
export function samePluginRelease(
  left: PluginRelease | undefined,
  right: PluginRelease | undefined,
) {
  return (
    !!left &&
    !!right &&
    left.revision === right.revision &&
    (left.publisher ?? null) === (right.publisher ?? null)
  );
}
