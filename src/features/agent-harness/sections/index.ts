// The base prompt's sections, in prompt order. Each is one topic with a
// stable id and its text in a file beside this one: `<id>.md`, and
// `<id>.<variant>.md` for each other text the host can pick.
//
// A text may name a tag, a tool, a file, or a locked section by its title.
// It must not name another section or say "above" or "below": a section that
// is not locked can be off or replaced, so the reference could point at
// nothing.
import audience from "./audience.md?raw";
import autonomy from "./autonomy.md?raw";
import callbacks from "./callbacks.md?raw";
import commitIdentity from "./commit-identity.md?raw";
import engineering from "./engineering.md?raw";
import etiquette from "./etiquette.md?raw";
import intro from "./intro.md?raw";
import memory from "./memory.md?raw";
import mentions from "./mentions.md?raw";
import productHelp from "./product-help.md?raw";
import progress from "./progress.md?raw";
import publishing from "./publishing.md?raw";
import repoConventions from "./repo-conventions.md?raw";
import routing from "./routing.md?raw";
import sessionModelChannel from "./session-model.channel.md?raw";
import sessionModelCommunity from "./session-model.community.md?raw";
import sessionModelInChannel from "./session-model.in-channel.md?raw";
import sessionModelInConversation from "./session-model.in-conversation.md?raw";
import sessionModelInThread from "./session-model.in-thread.md?raw";
import sessionModelStandalone from "./session-model.standalone.md?raw";
import sessionModelThread from "./session-model.thread.md?raw";
import threading from "./threading.md?raw";
import tools from "./tools.md?raw";
import trust from "./trust.md?raw";
import turnContract from "./turn-contract.md?raw";
import waiting from "./waiting.md?raw";
import workingLocationAssigned from "./working-location.assigned.md?raw";
import workingLocation from "./working-location.md?raw";
import workspaceLayout from "./workspace-layout.md?raw";
import workspaceLayoutOwnFolder from "./workspace-layout.own-folder.md?raw";

/** What the host knows of a session when it starts, which picks the text of
 * a host variant section. */
export type Facts = Readonly<{
  /** Whether each thread is a session of its own, or the whole channel or
   * community is one. */
  scope: "thread" | "channel" | "community";
  /** What the session is, for a harness that states it: one thread, one
   * whole conversation (a DM, a personal chat, a huddle or a channel's top
   * level), or a watch's or timer's run that joins no conversation. Without
   * it, the Session Model describes the scope alone. */
  place?: "thread" | "conversation" | "standalone" | undefined;
  /** The agent's workspace, absolute, when the conversation works in a folder
   * of its own instead. */
  ownFolder?: string | undefined;
}>;

export type Section = Readonly<{
  /** What saved choices name the section by. A released id is never given
   * to another section: a rename lists it in `aliases`. */
  id: string;
  /** The ids it had before a rename. A choice saved under one applies to
   * the section. */
  aliases?: readonly string[];
  /** The heading the host prints. Only the opening lines have none. */
  title?: string;
  /** The owner can turn the section off or give their own text. */
  owner?: true;
  /** A plugin can give its own text in a conversation it manages. */
  plugin?: true;
  /** The default text. A function is a host variant section: the facts pick
   * a complete text. */
  text: string | ((facts: Facts) => string);
}>;

/** Changes when a released section's id or title does, or one is removed:
 * a prompt with another layout has other sections to name. */
export const LAYOUT = 1;

export const SECTIONS: readonly Section[] = [
  { id: "intro", text: intro },
  { id: "turn-contract", title: "Incoming Turn Contract", text: turnContract },
  { id: "trust", title: "Trust", text: trust },
  { id: "tools", title: "Buzz Tools", text: tools },
  { id: "mentions", title: "Mentions", text: mentions },
  {
    id: "callbacks",
    title: "Callback Mentions",
    plugin: true,
    text: callbacks,
  },
  { id: "threading", title: "Threading", text: threading },
  { id: "routing", title: "Routing", plugin: true, text: routing },
  {
    id: "publishing",
    title: "Publishing",
    owner: true,
    plugin: true,
    text: publishing,
  },
  {
    id: "progress",
    title: "Progress",
    owner: true,
    plugin: true,
    text: progress,
  },
  { id: "waiting", title: "Waiting", text: waiting },
  { id: "etiquette", title: "Etiquette", owner: true, text: etiquette },
  { id: "audience", title: "Audience", text: audience },
  {
    id: "workspace-layout",
    title: "Workspace Layout",
    text: ({ ownFolder }) =>
      ownFolder
        ? workspaceLayoutOwnFolder.replace("{workspace}", () => ownFolder)
        : workspaceLayout,
  },
  { id: "memory", title: "Agent Memory", owner: true, text: memory },
  {
    id: "engineering",
    title: "Engineering Discipline",
    owner: true,
    text: engineering,
  },
  {
    id: "repo-conventions",
    title: "Working in the Repo",
    text: repoConventions,
  },
  {
    id: "commit-identity",
    title: "Commit identity",
    owner: true,
    text: commitIdentity,
  },
  {
    id: "working-location",
    title: "Working location",
    plugin: true,
    text: ({ ownFolder }) =>
      ownFolder ? workingLocationAssigned : workingLocation,
  },
  {
    id: "autonomy",
    title: "Autonomy",
    owner: true,
    plugin: true,
    text: autonomy,
  },
  {
    id: "session-model",
    title: "Session Model",
    text: ({ scope, place }) =>
      scope === "community"
        ? sessionModelCommunity
        : place === "standalone"
          ? sessionModelStandalone
          : !place
            ? scope === "thread"
              ? sessionModelThread
              : sessionModelChannel
            : scope === "channel"
              ? sessionModelInChannel
              : place === "thread"
                ? sessionModelInThread
                : sessionModelInConversation,
  },
  { id: "product-help", title: "Product help", text: productHelp },
];

/** Whether no setting, API or plugin can replace or remove the section's
 * text. */
export const locked = (section: Section) =>
  typeof section.text === "string" && !section.owner && !section.plugin;
