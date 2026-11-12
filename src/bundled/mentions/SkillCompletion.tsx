import { invoke } from "@tauri-apps/api/core";
import { useContext, useLayoutEffect } from "react";
import { useAgentChoices } from "../../features/agents/use-choices";
import type { HostCompletionResult } from "../../features/conversation/completion";
import type {
  CompletionResult,
  ComposerCompletionProps,
} from "../../features/conversation/contracts";
import { AddressedAgentsContext } from "../../features/messages/selected-mention-context";
import { BookIcon } from "../../shared/design-system/icons";
import { useHeldListing } from "./held-listing";

/** The folders each bundled local harness reads its own skills from, by
 * agent type. The host resolves `$CODEX_HOME` as Codex's launcher does. */
const SKILL_FOLDERS: Readonly<Record<string, readonly string[]>> = {
  "buzz.claude-code/claude-code": ["~/.claude/skills"],
  "buzz.codex/codex": ["$CODEX_HOME/skills", "~/.agents/skills"],
};
/** The chip keeps a short description for its details. */
const DESCRIPTION_LIMIT = 300;

type LocalSkill = Readonly<{
  name: string;
  description: string;
  path: string;
  displayPath: string;
}>;

/** `/` after a boundary, then name characters, as `@` mentions are matched. */
export function skillQuery(text: string, caret: number) {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
  const before = text.slice(Math.max(0, caret - 160), caret);
  const match = before.match(/(?:^|[\s([{])\/([\w-]*)$/u);
  if (!match) return null;
  const query = match[1] ?? "";
  const start = caret - query.length - 1;
  // A bounded slice beginning in the middle of a word is not a boundary.
  if (start && !/[\s([{]/u.test(text[start - 1] ?? "")) return null;
  return { start, end: caret, query };
}

/** `/` on desktop offers the skills of the one local Claude or Codex agent
 * the viewer's message addresses, from its skill folders on this machine, as
 * skill chips for that agent. */
export function SkillCompletion({
  session,
  scope,
  channelId,
  threadRootId,
  query,
  publish,
}: ComposerCompletionProps) {
  const addressed = useContext(AddressedAgentsContext);
  const choices = useAgentChoices(session, false);
  const agents = choices.identities.filter((choice) =>
    addressed.includes(choice.pubkey),
  );
  // A managed choice is the viewer's own agent on this machine.
  const agent =
    agents.length === 1 && agents[0]?.managed && agents[0].execution === "local"
      ? agents[0]
      : undefined;
  const folders = (agent?.type && SKILL_FOLDERS[agent.type]) || undefined;
  // One `/` token in one composer, for one agent, lists the skills once.
  const skills = useHeldListing(
    JSON.stringify([
      "skills",
      scope,
      channelId,
      threadRootId,
      query.start,
      agent?.pubkey ?? null,
    ]),
    async () =>
      folders
        ? invoke<readonly LocalSkill[]>("local_skills_list", { roots: folders })
        : [],
  );
  const several = agents.length > 1;
  const target = folders && agent?.pubkey;
  const group = agent && `Skills for ${agent.managedName ?? agent.name}`;
  useLayoutEffect(() => {
    let result: HostCompletionResult | undefined;
    if (several)
      result = { items: [], status: "Mention one agent to choose a skill." };
    else if (target && skills) {
      const needle = query.query.toLowerCase();
      const items = skills.rows
        .filter((skill) => skill.name.toLowerCase().includes(needle))
        .map((skill) => ({
          id: `skill:${skill.path}`,
          label: skill.name,
          preview: <BookIcon size={20} />,
          ...(group ? { group } : {}),
          edit: {
            token: {
              kind: "skill" as const,
              id: skill.path,
              label: skill.name,
              target,
              description: skill.description.slice(0, DESCRIPTION_LIMIT),
              location: skill.displayPath,
            },
          },
        }));
      // A query that names no skill is prose, as a path is.
      if (items.length || skills.error)
        result = skills.error
          ? { items, status: skills.error, retry: skills.retry }
          : { items };
    }
    if (!result) return;
    // The host accepts a chip edit only from a bundled provider.
    const withdraw = publish(result as unknown as CompletionResult);
    return () => {
      if (withdraw) withdraw();
    };
  }, [several, target, group, skills, query.query, publish]);
  return null;
}
