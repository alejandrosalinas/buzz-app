import {
  editSidebarAssignment,
  editSidebarSectionOrder,
  editSidebarSectionRemoval,
  editSidebarSectionRename,
  validSidebarSectionOrder,
  validSidebarSectionRemoval,
  validSidebarSectionRename,
  validSidebarAssignment,
} from "../src/features/relay/sidebar-edits.ts";
import { projectSidebarRecord } from "../src/features/relay/sidebar-registers.ts";
import { finalizeEvent, getPublicKey, nip44, verifyEvent } from "nostr-tools";
import {
  projectSidebarPreferences,
  SIDEBAR_COORDINATES,
} from "../src/features/relay/sidebar-preferences.ts";

export const SIDEBAR_REQUEST_BYTES = 960 * 1024; // Five bounded encrypted coordinates.
export const SIDEBAR_HEAD_BYTES = 192 * 1024 + 4096; // One signed coordinate plus response framing.
export const SIDEBAR_UPLOAD_SLOTS = 2;
export const SIDEBAR_UPLOAD_MS = 10_000;
/** Local host decoder, deliberately not an arbitrary NIP-44 decrypt capability. */
export function decodeSidebarPreferences(events, secret) {
  if (
    !Array.isArray(events) ||
    events.length > SIDEBAR_COORDINATES.length ||
    Buffer.byteLength(JSON.stringify(events)) > SIDEBAR_REQUEST_BYTES
  )
    throw new Error("Invalid sidebar records");
  const viewer = getPublicKey(secret);
  const coordinates = new Set();
  for (const event of events) {
    const tags = event?.tags?.filter?.(
      (tag) => Array.isArray(tag) && tag[0] === "d",
    );
    const coordinate = tags?.[0]?.[1];
    if (
      event?.kind !== 30078 ||
      event.pubkey !== viewer ||
      tags?.length !== 1 ||
      !SIDEBAR_COORDINATES.includes(coordinate) ||
      coordinates.has(coordinate) ||
      typeof event.content !== "string" ||
      !verifyEvent(event)
    )
      throw new Error("Invalid sidebar record");
    coordinates.add(coordinate);
  }
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  try {
    const decoded = new Map();
    for (const event of events) {
      const plaintext = nip44.v2.decrypt(event.content, key);
      if (Buffer.byteLength(plaintext) > 128 * 1024)
        throw new Error("Sidebar plaintext budget exceeded");
      decoded.set(
        event.tags.find((tag) => tag[0] === "d")[1],
        JSON.parse(plaintext),
      );
    }
    return projectSidebarPreferences(
      decoded.get("channel-sections"),
      decoded.get("channel-stars"),
      decoded.get("channel-mutes"),
      decoded.get("channel-sort"),
      undefined,
      decoded.get("channel-filter"),
    );
  } finally {
    key.fill(0);
  }
}

const SECTION_COORDINATE = "channel-sections";
function validAssignmentIntent(intent) {
  return (
    intent &&
    typeof intent === "object" &&
    !Array.isArray(intent) &&
    (intent.channelId === undefined || typeof intent.channelId === "string") &&
    (intent.sectionId === undefined || typeof intent.sectionId === "string") &&
    (intent.createSection === undefined ||
      (intent.createSection &&
        typeof intent.createSection === "object" &&
        !Array.isArray(intent.createSection) &&
        typeof intent.createSection.id === "string" &&
        typeof intent.createSection.name === "string" &&
        (intent.createSection.icon === undefined ||
          typeof intent.createSection.icon === "string") &&
        Object.keys(intent.createSection).every((key) =>
          ["id", "name", "icon", "position"].includes(key),
        ))) &&
    validSidebarAssignment(intent) &&
    Object.keys(intent).every((key) =>
      ["channelId", "sectionId", "createSection"].includes(key),
    )
  );
}
export function assertSidebarAssignmentIntent(intent) {
  if (!validAssignmentIntent(intent))
    throw new Error("Invalid sidebar assignment intent");
}
function parseSectionsEvent(events, secret) {
  if (
    !Array.isArray(events) ||
    events.length > 1 ||
    Buffer.byteLength(JSON.stringify(events)) > SIDEBAR_REQUEST_BYTES
  )
    throw new Error("Invalid sidebar group head");
  if (!events.length)
    return {
      blob: { version: 1, sections: [], assignments: {} },
      createdAt: 0,
    };
  const [event] = events;
  const viewer = getPublicKey(secret);
  const tags = event?.tags?.filter?.(
    (tag) => Array.isArray(tag) && tag[0] === "d",
  );
  if (
    event?.kind !== 30078 ||
    event.pubkey !== viewer ||
    tags?.length !== 1 ||
    tags[0]?.[1] !== SECTION_COORDINATE ||
    typeof event.content !== "string" ||
    !verifyEvent(event)
  )
    throw new Error("Invalid sidebar group head");
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  try {
    const plaintext = nip44.v2.decrypt(event.content, key);
    if (Buffer.byteLength(plaintext) > 128 * 1024)
      throw new Error("Sidebar plaintext budget exceeded");
    const blob = JSON.parse(plaintext);
    projectSidebarPreferences(blob, undefined);
    return {
      blob: projectSidebarRecord("channel-sections", blob),
      createdAt: event.created_at,
    };
  } finally {
    key.fill(0);
  }
}
/** Narrow host command: mutate one assignment against the latest encrypted head. */
export function prepareSidebarAssignment(
  events,
  intent,
  secret,
  now = Date.now(),
) {
  assertSidebarAssignmentIntent(intent);
  return prepareSections(events, secret, now, (current) =>
    editSidebarAssignment(current.blob, current.createdAt, intent, now),
  );
}
export function assertSidebarSectionRemovalIntent(intent) {
  if (
    !intent ||
    typeof intent !== "object" ||
    Array.isArray(intent) ||
    typeof intent.sectionId !== "string" ||
    !validSidebarSectionRemoval(intent.sectionId) ||
    Object.keys(intent).some((key) => key !== "sectionId")
  )
    throw new Error("Invalid sidebar section removal intent");
}
export function prepareSidebarSectionRemoval(
  events,
  intent,
  secret,
  now = Date.now(),
) {
  assertSidebarSectionRemovalIntent(intent);
  return prepareSections(events, secret, now, (current) =>
    editSidebarSectionRemoval(
      current.blob,
      current.createdAt,
      intent.sectionId,
      now,
    ),
  );
}
export function assertSidebarSectionRenameIntent(intent) {
  if (
    !intent ||
    typeof intent !== "object" ||
    Array.isArray(intent) ||
    typeof intent.sectionId !== "string" ||
    (intent.name !== undefined && typeof intent.name !== "string") ||
    (intent.icon !== undefined &&
      intent.icon !== null &&
      typeof intent.icon !== "string") ||
    !validSidebarSectionRename(intent.sectionId, intent.name, intent.icon) ||
    Object.keys(intent).some(
      (key) => key !== "sectionId" && key !== "name" && key !== "icon",
    )
  )
    throw new Error("Invalid sidebar section rename intent");
}
export function prepareSidebarSectionRename(
  events,
  intent,
  secret,
  now = Date.now(),
) {
  assertSidebarSectionRenameIntent(intent);
  return prepareSections(events, secret, now, (current) =>
    editSidebarSectionRename(
      current.blob,
      current.createdAt,
      intent.sectionId,
      { name: intent.name, icon: intent.icon },
      now,
    ),
  );
}
export function assertSidebarSectionOrderIntent(intent) {
  if (
    !intent ||
    typeof intent !== "object" ||
    Array.isArray(intent) ||
    !Array.isArray(intent.sectionIds) ||
    !intent.sectionIds.every((id) => typeof id === "string") ||
    !validSidebarSectionOrder(intent.sectionIds) ||
    Object.keys(intent).some((key) => key !== "sectionIds")
  )
    throw new Error("Invalid sidebar section order intent");
}
export function prepareSidebarSectionOrder(
  events,
  intent,
  secret,
  now = Date.now(),
) {
  assertSidebarSectionOrderIntent(intent);
  return prepareSections(events, secret, now, (current) =>
    editSidebarSectionOrder(
      current.blob,
      current.createdAt,
      intent.sectionIds,
      now,
    ),
  );
}
function prepareSections(events, secret, now, edit) {
  const viewer = getPublicKey(secret);
  const current = parseSectionsEvent(events, secret);
  const blob = edit(current);
  const groups = projectSidebarPreferences(blob, undefined);
  if (Buffer.byteLength(JSON.stringify(blob)) > 128 * 1024)
    throw new Error("Sidebar plaintext budget exceeded");
  if (blob === current.blob) return { groups };
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  let content;
  try {
    content = nip44.v2.encrypt(JSON.stringify(blob), key);
  } finally {
    key.fill(0);
  }
  return {
    groups,
    event: finalizeEvent(
      {
        kind: 30078,
        content,
        created_at: Math.max(Math.floor(now / 1000), current.createdAt + 1),
        tags: [
          ["d", SECTION_COORDINATE],
          ["t", SECTION_COORDINATE],
        ],
      },
      secret,
    ),
  };
}

/** Publish one assignment, then re-read the coordinate before reporting saved state. */
export async function mutateSidebarAssignment(
  intent,
  secret,
  readHead,
  publish,
) {
  assertSidebarAssignmentIntent(intent);
  return mutateSections(
    prepareSidebarAssignment,
    intent,
    secret,
    readHead,
    publish,
  );
}
export async function mutateSidebarSectionRemoval(
  intent,
  secret,
  readHead,
  publish,
) {
  assertSidebarSectionRemovalIntent(intent);
  return mutateSections(
    prepareSidebarSectionRemoval,
    intent,
    secret,
    readHead,
    publish,
  );
}
export async function mutateSidebarSectionRename(
  intent,
  secret,
  readHead,
  publish,
) {
  assertSidebarSectionRenameIntent(intent);
  return mutateSections(
    prepareSidebarSectionRename,
    intent,
    secret,
    readHead,
    publish,
  );
}
export async function mutateSidebarSectionOrder(
  intent,
  secret,
  readHead,
  publish,
) {
  assertSidebarSectionOrderIntent(intent);
  return mutateSections(
    prepareSidebarSectionOrder,
    intent,
    secret,
    readHead,
    publish,
  );
}
async function mutateSections(prepare, intent, secret, readHead, publish) {
  const draft = prepare(await readHead(), intent, secret);
  if (!draft.event) return draft.groups;
  await publish(draft.event);
  const confirmation = prepare(await readHead(), intent, secret);
  if (confirmation.event)
    throw new Error(
      "Sidebar groups changed on another device; reload and try again",
    );
  return confirmation.groups;
}
