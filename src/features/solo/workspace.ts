import { templateAgentChoices } from "../agents/choices";
import type { KitEntry, Lineup, Template } from "../channel-templates/model";
import {
  LIVE_CANVAS_BYTES,
  LIVE_CANVAS_LIMIT,
  parseKitRecord,
  parseLineup,
  resolveLineup,
} from "../channel-templates/model";
import { splitPartition } from "../relay/partition";
import type { RelaySession } from "../relay/session";

export type Workspace = {
  folders: string[];
  worktree?: { location: string; baseBranch: string } | undefined;
  canvas: string;
};
const prefix = "<!-- buzz-session-workspace:v1 ";
const end = "<!-- /buzz-session-workspace -->";
const worktreeRule =
  "- Make code changes in that new worktree. A task that only reads code, or does not use a repository, usually does not need one.";
// What earlier versions wrote instead, which Canvases saved then still hold.
const earlierWorktreeRule = "- Make all changes in that new worktree.";
export const emptyWorkspace = (): Workspace => ({ folders: [], canvas: "" });

export function validateWorkspace(value: Workspace): Workspace {
  const folders = [
    ...new Set(value.folders.map((path) => path.trim()).filter(Boolean)),
  ];
  const path = (value: string) =>
    value.length <= 2048 &&
    [...value].every((char) => char.charCodeAt(0) >= 32 && char !== "`");
  if (folders.length > 20 || folders.some((folder) => !path(folder)))
    throw new Error(
      "Use up to 20 workspace folders, without control characters or backticks.",
    );
  const worktree = value.worktree && {
    location: value.worktree.location.trim(),
    baseBranch: value.worktree.baseBranch.trim(),
  };
  if (
    worktree &&
    (!folders.length ||
      !worktree.location ||
      !path(worktree.location) ||
      !worktree.baseBranch ||
      !path(worktree.baseBranch))
  )
    throw new Error(
      "Choose a workspace folder, worktree location, and base branch.",
    );
  return { folders, ...(worktree ? { worktree } : {}), canvas: value.canvas };
}

/** Workspace preferences remain ordinary Canvas instructions, as in the reference workflow. */
export function workspaceCanvas(input: Workspace): string {
  const value = validateWorkspace(input);
  if (new TextEncoder().encode(value.canvas).length > LIVE_CANVAS_BYTES)
    throw new Error(`Keep Canvas below ${LIVE_CANVAS_LIMIT}.`);
  if (!value.folders.length) return value.canvas;
  const metadata = JSON.stringify({
    folders: value.folders,
    worktree: value.worktree,
  })
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
  const instructions = value.worktree
    ? [
        "## Workspace instructions",
        "",
        ...value.folders.map(
          (folder) =>
            `- Use \`${folder}\` for review only. Do not make changes directly in it.`,
        ),
        `- Before starting new work, fetch the latest \`${value.worktree.baseBranch}\` branch from origin.`,
        `- For each repository that needs changes, create a new worktree under \`${value.worktree.location}\` from \`origin/${value.worktree.baseBranch}\`.`,
        worktreeRule,
      ]
    : [
        "## Project folders",
        "",
        ...value.folders.map((folder) => `- \`${folder}\``),
      ];
  const canvas = [
    `${prefix}${metadata} -->`,
    ...instructions,
    end,
    "",
    value.canvas,
  ].join("\n");
  if (new TextEncoder().encode(canvas).length > LIVE_CANVAS_BYTES)
    throw new Error(
      `Keep Canvas and workspace instructions below ${LIVE_CANVAS_LIMIT}.`,
    );
  return canvas;
}

export function readWorkspace(content: string): Workspace {
  if (!content.startsWith(prefix)) return { folders: [], canvas: content };
  const value = parseWorkspace(content);
  const canvas = workspaceCanvas(value);
  // Never silently discard manually edited instructions inside the managed block.
  if (
    canvas !== content &&
    canvas.replace(worktreeRule, earlierWorktreeRule) !== content
  )
    throw new Error(
      "Workspace instructions were edited in Canvas. Use the raw Canvas editor to preserve those changes.",
    );
  return value;
}

/** The folders a Canvas's workspace block lets an agent work in: its project
 * folders, then its worktree location. Unlike `readWorkspace`, hand edits to
 * the block's instructions are kept, so an agent still finds its folders; a
 * missing or malformed block names none. */
export function workspaceDirectories(content: string): string[] {
  if (!content.startsWith(prefix)) return [];
  try {
    const { folders, worktree } = parseWorkspace(content);
    return [...new Set([...folders, ...(worktree ? [worktree.location] : [])])];
  } catch {
    return [];
  }
}

function parseWorkspace(content: string): Workspace {
  const lineEnd = content.indexOf(" -->\n");
  const blockEnd = content.indexOf(`\n${end}\n\n`, lineEnd);
  if (lineEnd < 0 || blockEnd < 0)
    throw new Error(
      "Workspace metadata is incomplete. Edit the raw Canvas before changing workspace settings.",
    );
  let raw: unknown;
  try {
    raw = JSON.parse(content.slice(prefix.length, lineEnd));
  } catch {
    throw new Error(
      "Workspace metadata is invalid. Edit the raw Canvas before changing workspace settings.",
    );
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    !("folders" in raw) ||
    !Array.isArray(raw.folders) ||
    raw.folders.some((v) => typeof v !== "string")
  )
    throw new Error("Invalid workspace folders.");
  const worktree = "worktree" in raw ? raw.worktree : undefined;
  if (
    worktree !== undefined &&
    (!worktree ||
      typeof worktree !== "object" ||
      !("location" in worktree) ||
      typeof worktree.location !== "string" ||
      !("baseBranch" in worktree) ||
      typeof worktree.baseBranch !== "string")
  )
    throw new Error("Invalid worktree settings.");
  return validateWorkspace({
    folders: raw.folders,
    ...(worktree
      ? { worktree: worktree as { location: string; baseBranch: string } }
      : {}),
    canvas: content.slice(blockEnd + end.length + 3),
  });
}

/** One existing encrypted template record per project. */
export async function projectTemplateId(projectId: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(projectId),
  );
  return `me-section-${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
/** The defaults record new chats in a project copy; validated for publication. */
export function projectTemplate(
  scope: string,
  id: string,
  projectName: string,
  lineup: Lineup,
): Template {
  const community = splitPartition(scope)?.communityOrigin;
  if (!community)
    throw new Error("Workspace defaults require a connected community.");
  const template: Template = {
    ...lineup,
    type: "template",
    id,
    name: `${projectName.slice(0, 100)} chats`,
    description:
      "Starting workspace and Canvas for new chats in this workspace.",
  };
  // Validate the complete encrypted recipe budget, including the community
  // URL, before publication.
  const record = parseKitRecord(
    { version: 1, community, deleted: false, value: template },
    community,
  );
  if (record.value.type !== "template")
    throw new Error("Expected workspace defaults");
  // Keep the exact parsed shape used on reread, including field order.
  return record.value;
}
export function templateEntry(entries: readonly KitEntry[], id: string) {
  return entries.find(
    (entry) =>
      !entry.record.deleted &&
      entry.record.value.type === "template" &&
      entry.record.value.id === id,
  );
}
export function projectDefault(
  entries: readonly KitEntry[],
  projectId: string,
  overrideId: string,
  requireDefault = false,
) {
  const override = templateEntry(entries, overrideId);
  if (override?.record.value.type === "template") return override.record.value;
  const groups = entries.find(
    (entry) => !entry.record.deleted && entry.record.value.type === "groups",
  )?.record.value;
  const defaultId =
    groups?.type === "groups"
      ? groups.groups.find((group) => group.id === projectId)?.defaultTemplateId
      : undefined;
  const fallback = defaultId
    ? templateEntry(entries, defaultId)?.record.value
    : undefined;
  if (requireDefault && defaultId && fallback?.type !== "template")
    throw new Error(
      "This workspace’s default template is unavailable. Choose new workspace defaults before starting a chat.",
    );
  return fallback?.type === "template" ? fallback : undefined;
}
export type ChatSetup = {
  projectId?: string;
  canvas: string;
  agents: string[];
};
export function parseChatSetup(raw: unknown): ChatSetup {
  if (
    !raw ||
    typeof raw !== "object" ||
    ("projectId" in raw &&
      raw.projectId !== undefined &&
      (typeof raw.projectId !== "string" ||
        !raw.projectId ||
        raw.projectId.length > 256))
  )
    throw new Error("Invalid saved chat workspace.");
  const lineup = parseLineup({ ...raw, teamIds: [] });
  return {
    ...("projectId" in raw && typeof raw.projectId === "string"
      ? { projectId: raw.projectId }
      : {}),
    canvas: lineup.canvas,
    agents: lineup.agents,
  };
}
/** Which saved defaults a setup was read from: it changes whenever any
 * saved kit record does. */
export function defaultsRevision(kit: { entries: readonly KitEntry[] }) {
  return kit.entries.map((entry) => entry.eventId).join();
}
export async function loadChatSetup(
  session: RelaySession,
  projectId: string,
): Promise<ChatSetup & { revision: string }> {
  const store = session.soloPreferences;
  await store.refresh();
  const preferences = store.snapshot();
  if (
    !store.writable ||
    !preferences.data?.sections.some((project) => project.id === projectId)
  )
    throw new Error(
      "This workspace is unavailable. Refresh workspaces before starting a chat.",
    );
  await session.channelKit.refresh();
  const kit = session.channelKit.snapshot();
  if (kit.status !== "ready")
    throw new Error(
      kit.error ??
        "Workspace defaults couldn’t load. Retry before starting the chat.",
    );
  const revision = defaultsRevision(kit);
  const template = projectDefault(
    kit.entries,
    projectId,
    await projectTemplateId(projectId),
    true,
  );
  if (!template) return { projectId, canvas: "", agents: [], revision };
  if (template.agents.length || template.teamIds.length) {
    await session.agentChoices.refresh("templates");
    const choices = session.agentChoices.snapshot();
    if (
      choices.templates.status !== "ready" ||
      !choices.templates.complete ||
      choices.archives.status !== "ready"
    )
      throw new Error(
        "Available agents couldn’t load. Retry before starting the chat.",
      );
    const roster = session.channels.list();
    const candidates = resolveLineup(
      template,
      kit.entries,
      choices.templates.identities,
    );
    if (
      candidates.some(
        (agent) =>
          !choices.templates.identities.find(
            (choice) => choice.pubkey === agent.pubkey,
          )?.managed,
      ) &&
      (roster.status !== "ready" || roster.coverage === "partial")
    ) {
      session.channels.refreshList?.();
      throw new Error(
        "Community membership couldn’t load completely. Refresh and retry before starting the chat.",
      );
    }
    const agents = resolveLineup(
      template,
      kit.entries,
      templateAgentChoices(choices, roster),
    ).map((agent) => agent.pubkey);
    return { projectId, canvas: template.canvas, agents, revision };
  }
  return { projectId, canvas: template.canvas, agents: [], revision };
}
