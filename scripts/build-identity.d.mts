export type BuildIdentity = {
  revision: string | null;
  state: "clean" | "dirty" | "unknown";
};

export function captureBuildIdentity(
  root: string,
  options?: { mutable?: boolean },
): BuildIdentity;
