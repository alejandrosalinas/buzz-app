import type { PluginModule } from "../../plugins/api";
import { LinkLabel, linkKind, githubSkillLabel } from "./InlineLink";
import styles from "../../shared/InlineReference.module.css";

export const inject = ["conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.conversation.registerLink({
    id: "links",
    title: "Links",
    matches: (url) => linkKind(url) !== null,
    // Specific for recognised services and Buzz entities; a catch-all for the
    // globe case, so a dedicated renderer wins unknown hosts at the default band.
    // Skill identity takes precedence over generic Markdown file presentation.
    order: (url) =>
      githubSkillLabel(url) ? -20 : linkKind(url) === "web" ? 100 : 0,
    className: styles.link,
    component: ({ url }) => <LinkLabel href={url} />,
  });
};
