import { avatarSource } from "../../shared/avatar-source";
import { newer } from "./events";
import type { EventData } from "./events";
import type { Profile } from "./contracts";

// Events are immutable; the directory refolds every retained profile per change.
const projected = new WeakMap<EventData, Profile>();

/** Display projection only; signed content stays intact. */
function profileName(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const name = value.trim();
  // Reordering and layout controls cannot be handled by collision comparison.
  // Preserve script joiners and variation selectors in the displayed name.
  if (!name || /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}\ufff9-\ufffb]/u.test(name))
    return;
  return name;
}

/** Kind 0 metadata. Only the author's own latest event counts. */
export function foldProfiles(
  events: readonly EventData[],
): Map<string, Profile> {
  const latest = new Map<string, EventData>();
  for (const event of events) {
    if (event.kind !== 0) continue;
    const previous = latest.get(event.pubkey);
    latest.set(event.pubkey, newer(previous, event));
  }
  const profiles = new Map<string, Profile>();
  for (const [pubkey, event] of latest) {
    const cached = projected.get(event);
    if (cached) {
      profiles.set(pubkey, cached);
      continue;
    }
    const auth = event.tags.find(
      (tag) =>
        tag.length === 4 &&
        tag[0] === "auth" &&
        /^[0-9a-f]{64}$/.test(tag[1] ?? "") &&
        /^[0-9a-f]{128}$/.test(tag[3] ?? ""),
    );
    const agent = auth
      ? { isAgent: true as const, ownerPubkey: auth[1] as string }
      : {};
    try {
      const body = JSON.parse(event.content) as {
        display_name?: unknown;
        name?: unknown;
        picture?: unknown;
        about?: unknown;
        nip05?: unknown;
        is_agent?: unknown;
        isAgent?: unknown;
      };
      const handle = profileName(body.name);
      const name = profileName(body.display_name) ?? handle;
      const picture = avatarSource(body.picture);
      profiles.set(
        pubkey,
        Object.freeze({
          name: name ?? pubkey.slice(0, 10),
          ...(!name ? { nameIsFallback: true as const } : {}),
          ...(handle && handle !== name ? { username: handle } : {}),
          ...agent,
          ...(picture ? { picture } : {}),
          ...(typeof body.about === "string" && body.about.trim()
            ? { about: body.about.trim() }
            : {}),
          ...(typeof body.nip05 === "string" && body.nip05.trim()
            ? { nip05: body.nip05.trim() }
            : {}),
          ...(body.is_agent === true || body.isAgent === true
            ? { isAgent: true as const }
            : {}),
        }),
      );
    } catch {
      profiles.set(
        pubkey,
        Object.freeze({
          name: pubkey.slice(0, 10),
          nameIsFallback: true,
          ...agent,
        }),
      );
    }
    projected.set(event, profiles.get(pubkey) as Profile);
  }
  return profiles;
}
