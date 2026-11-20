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
import { readView, writeView } from "../../shared/view-state";
import type { RelaySession } from "../relay/session";

export type Workspace = {
  folders: string[];
  worktree?: { location: string; baseBranch: string } | undefined;
  canvas: string;
};
const prefix = "<!-- buzz-session-workspace:v1 ";
const end = "<!-- /buzz-session-workspace -->";
/** In both workspace block delimiters. */
const marker = "buzz-session-workspace";
const worktreeRule =
  "- Make code changes in that new worktree. A task that only reads code, or does not use a repository, usually does not need one.";
// What earlier versions wrote instead, which Canvases saved then still hold.
const earlierWorktreeRule = "- Make all changes in that new worktree.";
// What an agent reads with the block, which no Canvas holds.
const ownerRule =
  "The owner wrote the worktree rules of this block. They replace this conversation's working-location rule.";
const followUpRule = (location: string) =>
  `- These steps are for new work. For follow-up work on an existing branch or pull request, keep using that branch: reuse its linked worktree, or add one under \`${location}\` if it has none.`;
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

/** What the workspace block tells an agent about its folders. */
function instructions(value: Workspace) {
  return value.worktree
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
  const canvas = [
    `${prefix}${metadata} -->`,
    ...instructions(value),
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
  // Saved content can fit even when the current managed header is longer.
  // Check its exact format here; the writer enforces the current size budget.
  const canvas = workspaceCanvas({ ...value, canvas: "" }) + value.canvas;
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

/** A workspace Canvas's instructions, safe to copy to a shared Canvas: empty
 * when any workspace metadata remains (misplaced, nested or malformed), since
 * it names local folders. */
export function shareableInstructions(content: string): string {
  try {
    const { canvas } = readWorkspace(content);
    return canvas.includes(marker) ? "" : canvas;
  } catch {
    return "";
  }
}

/** A Canvas's workspace block: its settings, and whether its text is other
 * than what Buzz generates from them, so its owner edited it by hand.
 * Undefined when the Canvas has no block or it cannot be read. */
function workspaceBlock(content: string) {
  if (!content.startsWith(prefix)) return undefined;
  try {
    const value = parseWorkspace(content);
    const generated = workspaceCanvas({ ...value, canvas: "" });
    if (!generated) return undefined;
    return {
      value,
      edited:
        !content.startsWith(generated) &&
        !content.startsWith(
          generated.replace(worktreeRule, earlierWorktreeRule),
        ),
    };
  } catch {
    return undefined;
  }
}

/** Whether the Canvas's workspace block has worktree rules that its owner
 * edited by hand. They are the owner's rule for the chat, also when the
 * conversation works in a folder of its own. */
export function ownerWorktreeRules(content: string) {
  const block = workspaceBlock(content);
  return !!block?.edited && !!block.value.worktree;
}

/** A Canvas as its agent reads it. A workspace block that Buzz generated is
 * printed again from its settings, so what an agent is told can change
 * without changing what Canvases hold. `ownFolder`: the conversation works in
 * a folder of its own, so the block only lists the folders. A block edited by
 * hand stays as written, as does one that cannot be read. When the owner
 * wrote the Canvas, its worktree rules are then the owner's rule for this
 * chat, which the text says. */
export function agentCanvas(
  content: string,
  ownFolder = false,
  ownerWrote = true,
): string {
  const block = workspaceBlock(content);
  if (!block) return content;
  const { value } = block;
  if (block.edited) {
    if (!ownFolder || !value.worktree || !ownerWrote) return content;
    const at = content.length - value.canvas.length;
    return `${content.slice(0, at)}${ownerRule}\n\n${content.slice(at)}`;
  }
  const lines = instructions(
    ownFolder ? { ...value, worktree: undefined } : value,
  );
  if (!ownFolder && value.worktree)
    lines.push(followUpRule(value.worktree.location));
  return `${lines.join("\n")}\n\n${value.canvas}`;
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

// Channel templates are on this device, so which one a workspace last applied
// is too; its settings reopen showing it.
const appliedTemplateKey = (projectId: string) =>
  `solo:workspace-template:${projectId}`;
export const appliedTemplate = {
  read: (scope: string, projectId: string) =>
    readView(scope, appliedTemplateKey(projectId), ""),
  /** Custom settings (`""`) forgets it. */
  write: (scope: string, projectId: string, templateId: string) =>
    writeView(scope, appliedTemplateKey(projectId), templateId || null),
};

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
  overrideId: string,
  defaultId?: string,
  requireDefault = false,
) {
  const override = templateEntry(entries, overrideId);
  if (override?.record.value.type === "template") return override.record.value;
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
  const store = session.sidebarPreferences;
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
    await projectTemplateId(projectId),
    preferences.data.legacyTemplates?.[projectId],
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
