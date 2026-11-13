import type { Communities } from "./service";

// Profile saves per app instance. Settings uses the generation to let only the
// newest save update the local default; background profile writes use it to
// stand aside while a save is running or after one has started.
const generations = new WeakMap<Communities, number>();
const running = new WeakMap<Communities, number>();
// Background profile writes already handed to the writer and not yet settled.
const background = new WeakMap<Communities, Set<Promise<unknown>>>();

export function beginProfileSave(communities: Communities) {
  const generation = profileSaveGeneration(communities) + 1;
  generations.set(communities, generation);
  running.set(communities, (running.get(communities) ?? 0) + 1);
  return generation;
}

export function endProfileSave(communities: Communities) {
  running.set(communities, Math.max(0, (running.get(communities) ?? 0) - 1));
}

export function isCurrentProfileSave(
  communities: Communities,
  generation: number,
) {
  return profileSaveGeneration(communities) === generation;
}

export function profileSaveGeneration(communities: Communities) {
  return generations.get(communities) ?? 0;
}

/** Whether a profile save is running, or one started after `generation`. */
export function profileSavedSince(
  communities: Communities,
  generation: number,
) {
  return (
    profileSaveGeneration(communities) !== generation ||
    (running.get(communities) ?? 0) > 0
  );
}

/** Records a background profile write that has been handed to the writer, so
 * a save can wait for it and then read what it published. */
export function trackBackgroundProfileWrite(
  communities: Communities,
  write: Promise<unknown>,
) {
  const writes = background.get(communities) ?? new Set<Promise<unknown>>();
  background.set(communities, writes);
  const settled = write.then(
    () => {},
    () => {},
  );
  writes.add(settled);
  void settled.then(() => writes.delete(settled));
}

/** Settles once every unsettled background profile write has; undefined when
 * there is none, so a save need not wait at all. */
export function backgroundProfileWrites(
  communities: Communities,
): Promise<unknown> | undefined {
  const writes = background.get(communities);
  return writes?.size ? Promise.all(writes) : undefined;
}
