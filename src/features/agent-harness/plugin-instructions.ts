// The standing instructions plugins give every turn (`Agents.addInstructions`)
// and one conversation's turns (`Agents.setConversationInstructions`), shown
// the same way whatever harness runs the agent.
import type { TurnInstructions } from "../agents/service";
import { unframed } from "./plugin-wake";

/** `text` as a section body: it cannot open a section posing as another
 * plugin's or the owner's, or close its own, the turn's event or its steer
 * section early (steering finds the event by its closing tag). */
const body = (text: string) =>
  unframed(
    text
      .trim()
      .replace(/<(plugin|owner)-instructions/gi, "<\\$1-instructions")
      .replace(
        /<\/(plugin-instructions|owner-instructions|buzz-event|new-message-arrived-while-you-were-working)/gi,
        "<\\/$1",
      ),
  );
const attribute = (plugin: string) => plugin.replace(/[^\w.:-]/g, "");

/** One `<plugin-instructions>` section for each plugin's instructions, or
 * undefined when there are none. A turn's sections are the complete current
 * set, which the base prompt says replaces earlier turns'. Each section names
 * its plugin, so a transcript shows which plugin gave which instructions.
 * That keeps the prompt well formed and attributed; it is not a trust
 * boundary, since the text is the trusted plugin's own. */
export function pluginInstructions(entries: readonly TurnInstructions[] = []) {
  const sections = entries.map(
    ({ plugin, text }) =>
      `<plugin-instructions plugin="${attribute(plugin)}">\n${body(text)}\n</plugin-instructions>`,
  );
  return sections.length ? sections.join("\n\n") : undefined;
}

/** The `<owner-instructions>` section for one conversation's instructions,
 * named by the plugin that gave them; cleared ones say none apply now. */
export function ownerInstructions(entry: TurnInstructions | undefined) {
  if (!entry) return undefined;
  const text = body(entry.text);
  const content = text
    ? `Your owner's standing instructions for you in this conversation, as of this message. They replace any earlier <owner-instructions>. Your owner's messages override them. Where they conflict with a workspace Canvas, follow these.\n\n${text}`
    : "Your owner has no standing instructions for you in this conversation now. Disregard any earlier <owner-instructions>.";
  return `<owner-instructions source="${attribute(entry.plugin)}">\n${content}\n</owner-instructions>`;
}
