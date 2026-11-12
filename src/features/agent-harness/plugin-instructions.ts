// The standing instructions plugins give every turn (`Agents.addInstructions`),
// shown the same way whatever harness runs the agent.
import type { TurnInstructions } from "../agents/service";
import { unframed } from "./plugin-wake";

/** One `<plugin-instructions>` section for each plugin's instructions, or
 * undefined when there are none. A turn's sections are the complete current
 * set, which the base prompt says replaces earlier turns'. Each section names
 * its plugin, so a transcript shows which plugin gave which instructions: a
 * plugin's text cannot open a section posing as another plugin's, or close
 * its own, the turn's event or its steer section early (steering finds the
 * event by its closing tag). That keeps the prompt well formed and attributed;
 * it is not a trust boundary, since the text is the trusted plugin's own. */
export function pluginInstructions(entries: readonly TurnInstructions[] = []) {
  const sections = entries.map(({ plugin, text }) => {
    const body = unframed(
      text
        .trim()
        .replace(/<plugin-instructions/gi, "<\\plugin-instructions")
        .replace(
          /<\/(plugin-instructions|buzz-event|new-message-arrived-while-you-were-working)/gi,
          "<\\/$1",
        ),
    );
    return `<plugin-instructions plugin="${plugin.replace(/[^\w.:-]/g, "")}">\n${body}\n</plugin-instructions>`;
  });
  return sections.length ? sections.join("\n\n") : undefined;
}
