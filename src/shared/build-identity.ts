export type BuildSourceState = "clean" | "dirty" | "unknown";

export type BuildIdentity = {
  revision: string | null;
  state: BuildSourceState;
};

export function buildIdentity(
  revision: string | null | undefined,
  state: string | null | undefined,
): BuildIdentity {
  const normalizedRevision =
    revision && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(revision)
      ? revision
      : null;
  const normalizedState =
    normalizedRevision && (state === "clean" || state === "dirty")
      ? state
      : "unknown";
  return { revision: normalizedRevision, state: normalizedState };
}

export function describeBuildIdentity(identity: BuildIdentity): string {
  return identity.revision
    ? `${identity.revision} · ${identity.state}`
    : "unknown";
}
