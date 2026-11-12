import { MentionCompletion } from "./MentionCompletion";
import { mentionQuery } from "./mention-query";
import type { PluginModule } from "../../plugins/api";
import { MentionPicker } from "./MentionPicker";
import { FolderCompletion, folderQuery } from "./FolderCompletion";
import { SkillCompletion, skillQuery } from "./SkillCompletion";

export const inject = ["conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.conversation.registerCompletion({
    id: "typeahead",
    title: "Mention",
    order: -10,
    match: ({ text, start }) => mentionQuery(text, start),
    component: MentionCompletion,
  });
  ctx.conversation.registerCompletion({
    id: "folders",
    title: "Folders",
    match: ({ text, start }) => folderQuery(text, start),
    component: FolderCompletion,
  });
  ctx.conversation.registerCompletion({
    id: "skills",
    title: "Skills",
    match: ({ text, start }) => skillQuery(text, start),
    component: SkillCompletion,
  });
  ctx.conversation.registerTool({
    id: "picker",
    title: "Mentions",
    order: -10,
    component: ({
      session,
      scope,
      channelId,
      disabled,
      insertMention,
      insertMentions,
      inviteAgents,
      audience,
      focus,
    }) => (
      <MentionPicker
        session={session}
        scope={scope}
        channelId={channelId}
        disabled={disabled}
        inviteAgents={inviteAgents}
        audience={audience}
        select={insertMention}
        selectTeam={insertMentions}
        focusDraft={focus}
      />
    ),
  });
};
