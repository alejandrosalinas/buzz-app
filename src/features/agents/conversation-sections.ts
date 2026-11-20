// The base prompt sections a plugin replaced for one agent in one
// conversation: the plugin that holds this record manages the conversation.
// It is kept on this device, keyed as harnesses key the conversation's
// session. A turn's prompt uses it only while that plugin is on and its
// manifest declares the section, which the host checks when it builds the
// prompt.
import { pluginSection } from "../agent-harness/sections";
import {
  SECTION_TEXT_BYTES,
  textProblem,
} from "../agent-harness/sections/choices";
import type { AgentKey } from "./membership";
import type { AgentStore } from "./store";

export const CONVERSATION_SECTIONS_PREFIX =
  "buzz.agents.conversation-sections.v1:";
/** The most UTF-8 bytes one conversation's texts have together. */
export const CONVERSATION_SECTIONS_BYTES = 12 * 1024;
const storageKey = (scope: string, agent: AgentKey, conversation: string) =>
  `${CONVERSATION_SECTIONS_PREFIX}${JSON.stringify([scope, agent, conversation])}`;

/** Section ID → the plugin's text for it. */
type Texts = Readonly<Record<string, string>>;
export type ConversationSections = Readonly<{
  plugin: string;
  sections: Texts;
}>;

const bytes = (text: string) => new TextEncoder().encode(text).length;
/** The current IDs of the sections a manifest's `declared` names. */
const named = (declared: readonly string[]) =>
  new Set(declared.map((id) => pluginSection(id)?.id));

/** `sections` as they are kept: each under its section's current ID, with
 * its text trimmed. Rejects a section a plugin cannot replace, one that
 * `declared`, the plugin's manifest, does not name, and a text or a set that
 * cannot be used. */
export function checkedSections(
  sections: Texts,
  declared: readonly string[],
): Texts {
  if (!sections || typeof sections !== "object" || Array.isArray(sections))
    throw new Error("Conversation sections are section IDs with their text");
  const allowed = named(declared);
  const checked: Record<string, string> = {};
  for (const [id, value] of Object.entries(sections)) {
    const section = pluginSection(id);
    if (!section)
      throw new Error(
        `A plugin cannot replace the agent prompt section "${id}"`,
      );
    if (!allowed.has(section.id))
      throw new Error(
        `The plugin's manifest does not declare the agent prompt section "${id}"`,
      );
    const text = typeof value === "string" ? value.trim() : "";
    if (!text)
      throw new Error(
        `The section "${id}" needs text: a plugin cannot turn a section off`,
      );
    if (bytes(text) > SECTION_TEXT_BYTES)
      throw new Error(
        `The text for the section "${id}" is over ${SECTION_TEXT_BYTES} bytes`,
      );
    if (textProblem(text))
      throw new Error(
        `The text for the section "${id}" has control characters`,
      );
    checked[section.id] = text;
  }
  if (bytes(Object.values(checked).join("")) > CONVERSATION_SECTIONS_BYTES)
    throw new Error(
      `Conversation sections are over ${CONVERSATION_SECTIONS_BYTES} bytes`,
    );
  return checked;
}

/** Each store's saved value of a record while saves to it are still being
 * written, and the plugin of each of those saves, in order: none for one
 * that removes it. A store shows a value as soon as it is written, and puts
 * the saved one back if the write fails. */
const saving = new WeakMap<
  Pick<AgentStore, "get">,
  Map<string, { saved: string | null; plugins: (string | undefined)[] }>
>();

const parsed = (saved: string | null): ConversationSections | undefined => {
  if (!saved) return undefined;
  try {
    const { plugin, sections } = JSON.parse(
      saved,
    ) as Partial<ConversationSections>;
    if (
      typeof plugin === "string" &&
      sections &&
      typeof sections === "object" &&
      Object.values(sections).every((text) => typeof text === "string")
    )
      return { plugin, sections };
  } catch {
    // Unreadable, as if it had none.
  }
  return undefined;
};

/** The conversation's saved record; undefined when it has none or it cannot
 * be read. A turn must not take a record whose save then fails. */
export function conversationSections(
  store: Pick<AgentStore, "get">,
  scope: string,
  agent: AgentKey,
  conversation: string,
): ConversationSections | undefined {
  const key = storageKey(scope, agent, conversation);
  const pending = saving.get(store)?.get(key);
  return parsed(pending ? pending.saved : store.get(key));
}

/** The plugins that claim the conversation: the one whose record is saved,
 * and each one with a save that is still being written. A plugin claims it
 * from the start of its save until a removal of its record is saved. */
export function sectionsClaims(
  store: Pick<AgentStore, "get">,
  scope: string,
  agent: AgentKey,
  conversation: string,
): ReadonlySet<string> {
  const key = storageKey(scope, agent, conversation);
  const pending = saving.get(store)?.get(key);
  const saved = parsed(pending ? pending.saved : store.get(key))?.plugin;
  return new Set(
    [saved, ...(pending?.plugins ?? [])].filter(
      (plugin): plugin is string => !!plugin,
    ),
  );
}

/** The record's texts that a prompt may use now: those `declared`, the
 * manifest of the plugin that is on, still names. */
export function usableSections(
  { sections }: ConversationSections,
  declared: readonly string[],
): Texts {
  const allowed = named(declared);
  return Object.fromEntries(
    Object.entries(sections).flatMap(([id, text]) => {
      const section = pluginSection(id);
      return section && allowed.has(section.id) && !textProblem(text)
        ? [[section.id, text] as const]
        : [];
    }),
  );
}

/** Replaces the conversation's record with `sections`, which `plugin` gave;
 * none removes it. */
export async function setConversationSections(
  store: AgentStore,
  scope: string,
  agent: AgentKey,
  conversation: string,
  plugin: string,
  sections: Texts,
) {
  const key = storageKey(scope, agent, conversation);
  const value = Object.keys(sections).length
    ? JSON.stringify({ plugin, sections })
    : null;
  const writes = saving.get(store) ?? new Map();
  saving.set(store, writes);
  const pending = writes.get(key) ?? {
    saved: store.get(key),
    plugins: [] as (string | undefined)[],
  };
  pending.plugins.push(value ? plugin : undefined);
  writes.set(key, pending);
  try {
    await store.set(key, value);
    // Writes are saved in order, so this is now the saved value.
    pending.saved = value;
  } finally {
    // Writes settle in order, so this one is the first still listed.
    pending.plugins.shift();
    if (!pending.plugins.length) writes.delete(key);
  }
}

/** Drops every conversation's record for the agent, in every scope. A
 * failure only warns: it must not stop the agent's removal. */
export async function forgetConversationSections(
  store: AgentStore,
  agent: AgentKey,
) {
  const keys = store.keys().filter((key) => {
    if (!key.startsWith(CONVERSATION_SECTIONS_PREFIX)) return false;
    try {
      return (
        (
          JSON.parse(key.slice(CONVERSATION_SECTIONS_PREFIX.length)) as string[]
        )[1] === agent
      );
    } catch {
      return false;
    }
  });
  await Promise.all(keys.map((key) => store.set(key, null))).catch((error) =>
    console.warn("Conversation sections were not removed", error),
  );
}
