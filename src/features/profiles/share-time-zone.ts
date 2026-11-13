import { profileFromEvent } from "../communities/api";
import {
  profileSaveGeneration,
  profileSavedSince,
  trackBackgroundProfileWrite,
} from "../communities/profile-saves";
import type { Communities, PersonalProfile } from "../communities/service";
import { newer, type EventData } from "../relay/events";
import { profileTimeZone } from "./local-time";

export const deviceTimeZone = () =>
  profileTimeZone(new Intl.DateTimeFormat().resolvedOptions().timeZone);

/** `existing` with this device's zone added when the profile has never had a
 * `tz` key; an empty `tz` is an opt-out and stays. */
export function withDeviceTimeZone(
  existing: Record<string, unknown>,
  zone: string | undefined,
): Record<string, unknown> {
  return zone && !("tz" in existing) ? { ...existing, tz: zone } : existing;
}

// Community and viewer pairs already settled. A pair whose profile was read
// is remembered on this device, so sharing by default happens at most once per
// device: a later missing `tz` (another app rewrote the profile) stays alone.
const storageKey = "buzz-shared-time-zones.v1";
let settled: Set<string> | undefined;
function settledPairs() {
  if (settled) return settled;
  settled = new Set();
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (Array.isArray(saved))
      for (const key of saved) if (typeof key === "string") settled.add(key);
  } catch {}
  return settled;
}
function storeSettled() {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...settledPairs()]));
  } catch {}
}
// The share in flight per pair; a replacement waits for it before checking.
const running = new Map<string, Promise<boolean>>();

type ProfileRead = ReturnType<typeof profileFromEvent>;

/** Whether a background write may add `tz`: the profile exists, has no `tz`
 * key, and the profile writer would leave its other fields as they are. */
function shareable({ exists, existing, profile }: ProfileRead) {
  if (!exists || "tz" in existing) return false;
  const name = profile.name.trim();
  const written: Record<string, unknown> = {
    name,
    display_name: name,
    picture: profile.picture,
    about: profile.about?.trim() ?? "",
  };
  return (
    !!name &&
    !Object.entries(written).some(
      ([field, value]) => field in existing && existing[field] !== value,
    )
  );
}

/** Shares the device zone once per launch per community. A fresh read of the
 * viewer's own profile triggers it; a strong read just before publishing is
 * what gets published, so a lagging read never reverts a newer profile.
 * Publishes only into an existing profile that has no `tz` key, only when the
 * profile writer would leave its other fields as they are (so a background
 * write never renames anyone), and never while a profile save is running or
 * after one started. Resolves whether it published; a failed read leaves the
 * next fresh read to try. */
export function shareDeviceTimeZone(
  options: Parameters<typeof attemptShare>[0],
): Promise<boolean> {
  const key = `${options.community}\n${options.viewer}`;
  // A run abandoned mid-read releases the pair only when it settles, so the
  // replacement checks after it.
  const previous = running.get(key);
  const current = (async () => {
    await previous;
    return attemptShare(options);
  })();
  running.set(key, current);
  void current.finally(() => {
    if (running.get(key) === current) running.delete(key);
  });
  return current;
}

async function attemptShare({
  community,
  viewer,
  communities,
  read,
  inspect,
  publish,
  signal,
  zone,
}: {
  community: string;
  viewer: string;
  /** The app's communities, whose profile saves this write stands aside for. */
  communities: Communities;
  /** The fresh background read that triggers the share. */
  read: Promise<readonly EventData[]>;
  /** A strong read of the viewer's profile, as `inspectProfile` returns. */
  inspect(): Promise<ProfileRead>;
  publish(
    profile: PersonalProfile,
    existing: Record<string, unknown>,
  ): Promise<void>;
  signal?: AbortSignal;
  /** This device's zone, from `deviceTimeZone()`. */
  zone: string | undefined;
}): Promise<boolean> {
  const key = `${community}\n${viewer}`;
  const pairs = settledPairs();
  if (pairs.has(key)) return false;
  const saves = profileSaveGeneration(communities);
  let events: readonly EventData[];
  try {
    events = await read;
  } catch {
    return false;
  }
  if (signal?.aborted || pairs.has(key)) return false;
  pairs.add(key);
  let latest: EventData | undefined;
  for (const event of events)
    if (event.kind === 0 && event.pubkey === viewer)
      latest = newer(latest, event);
  if (!latest || !zone) return false;
  storeSettled();
  try {
    if (!shareable(profileFromEvent(latest))) return false;
  } catch {
    return false;
  }
  let current: ProfileRead;
  try {
    current = await inspect();
  } catch {
    pairs.delete(key);
    storeSettled();
    return false;
  }
  if (signal?.aborted) {
    pairs.delete(key);
    storeSettled();
    return false;
  }
  if (!shareable(current) || profileSavedSince(communities, saves))
    return false;
  try {
    const write = publish(
      current.profile,
      withDeviceTimeZone(current.existing, zone),
    );
    trackBackgroundProfileWrite(communities, write);
    await write;
    return true;
  } catch {
    // Unpublished: let the next fresh read try again.
    pairs.delete(key);
    storeSettled();
    return false;
  }
}

/** Test seam: forget which communities were settled. */
export function resetSharedTimeZones() {
  settled = undefined;
  try {
    localStorage.removeItem(storageKey);
  } catch {}
  running.clear();
}
