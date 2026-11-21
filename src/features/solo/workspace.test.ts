import { expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import {
  LIVE_CANVAS_BYTES,
  LIVE_CANVAS_LIMIT,
  parseKitRecord,
} from "../channel-templates/model";
import {
  agentCanvas,
  validateWorkspace,
  loadChannelSetup,
  loadChatSetup,
  readWorkspace,
  projectTemplateId,
  workspaceCanvas,
  workspaceDirectories,
  shareableInstructions,
} from "./workspace";

it.each([{ folders: [] }, { folders: [" ", "\t"] }])(
  "requires a nonempty folder only in worktree mode (%j)",
  ({ folders }) => {
    const workspace = { folders, canvas: "Keep this" };
    expect(validateWorkspace(workspace)).toEqual({
      folders: [],
      canvas: "Keep this",
    });
    const worktree = { location: "~/worktrees", baseBranch: "main" };
    expect(() => validateWorkspace({ ...workspace, worktree })).toThrow(
      "Choose a workspace folder, worktree location, and base branch.",
    );
    expect(
      validateWorkspace({ ...workspace, folders: [" ~/repo "], worktree }),
    ).toEqual({ ...workspace, folders: ["~/repo"], worktree });
  },
);

it("round trips folders, worktrees and Canvas through existing template records", async () => {
  const workspace = {
    folders: ["/workspace/one", "~/Development/two"],
    worktree: { location: "~/.buzz/worktrees", baseBranch: "develop" },
    canvas: "# Goal\nShip it\n",
  };
  const canvas = workspaceCanvas(workspace);
  expect(readWorkspace(canvas)).toEqual(workspace);
  expect(canvas).toContain("origin/develop");
  const id = await projectTemplateId("section-one");
  // Existing project defaults records are found by this exact id.
  expect(id).toMatch(/^me-section-[0-9a-f]{64}$/);
  expect(id).toBe(await projectTemplateId("section-one"));
  expect(id).not.toBe(await projectTemplateId("section-two"));
  const record = parseKitRecord(
    {
      version: 1,
      community: "https://relay.test",
      deleted: false,
      value: {
        type: "template",
        id,
        name: "Work chats",
        description: "",
        teamIds: [],
        agents: [],
        canvas,
      },
    },
    "https://relay.test",
  );
  expect(record.value).toHaveProperty("canvas", canvas);
});
it("reads folder-only Canvas saved by earlier versions without treating it as edited", () => {
  // Literal saved format: the managed block is persisted, not display copy.
  const saved = [
    '<!-- buzz-session-workspace:v1 {"folders":["/repo"]} -->',
    "## Project folders",
    "",
    "- `/repo`",
    "<!-- /buzz-session-workspace -->",
    "",
    "Instructions",
  ].join("\n");
  expect(readWorkspace(saved)).toEqual({
    folders: ["/repo"],
    canvas: "Instructions",
  });
});
it("reads worktree Canvas saved with the earlier worktree rule without treating it as edited", () => {
  const saved = [
    '<!-- buzz-session-workspace:v1 {"folders":["/repo"],"worktree":{"location":"~/trees","baseBranch":"main"}} -->',
    "## Workspace instructions",
    "",
    "- Use `/repo` for review only. Do not make changes directly in it.",
    "- Before starting new work, fetch the latest `main` branch from origin.",
    "- For each repository that needs changes, create a new worktree under `~/trees` from `origin/main`.",
    "- Make all changes in that new worktree.",
    "<!-- /buzz-session-workspace -->",
    "",
    "Instructions",
  ].join("\n");
  const workspace = {
    folders: ["/repo"],
    worktree: { location: "~/trees", baseBranch: "main" },
    canvas: "Instructions",
  };
  expect(readWorkspace(saved)).toEqual(workspace);
  const body = "x".repeat(
    LIVE_CANVAS_BYTES - saved.length + workspace.canvas.length,
  );
  const full = saved.slice(0, -workspace.canvas.length) + body;
  expect(readWorkspace(full)).toEqual({ ...workspace, canvas: body });
  expect(() =>
    readWorkspace(full.replace("Make all changes", "Make no changes")),
  ).toThrow("edited");
  expect(() => workspaceCanvas({ ...workspace, canvas: body })).toThrow(
    LIVE_CANVAS_LIMIT,
  );
  // Saved again, it gets the current rule.
  expect(workspaceCanvas(workspace)).toContain(
    "- Make code changes in that new worktree.",
  );
  expect(() =>
    readWorkspace(saved.replace("Make all changes", "Make no changes")),
  ).toThrow("edited");
});
it("preserves ordinary Canvas and refuses malformed or manually changed workspace blocks", () => {
  expect(readWorkspace("# Existing\nKeep me")).toEqual({
    folders: [],
    canvas: "# Existing\nKeep me",
  });
  expect(() => readWorkspace("<!-- buzz-session-workspace:v1 broken")).toThrow(
    "incomplete",
  );
  const canvas = workspaceCanvas({
    folders: ["/repo"],
    canvas: "Instructions",
  });
  expect(() =>
    readWorkspace(canvas.replace("- `/repo`", "- `/other`")),
  ).toThrow("edited");
  expect(() =>
    workspaceCanvas({ folders: ["/repo`\nunsafe"], canvas: "" }),
  ).toThrow("folders");
  expect(
    workspaceCanvas({ folders: [], canvas: "x".repeat(LIVE_CANVAS_BYTES) }),
  ).toHaveLength(LIVE_CANVAS_BYTES);
  expect(() =>
    workspaceCanvas({
      folders: [],
      canvas: "x".repeat(LIVE_CANVAS_BYTES + 1),
    }),
  ).toThrow(LIVE_CANVAS_LIMIT);
});

function fixture() {
  const kit = { status: "ready", entries: [] as unknown[] };
  const session = {
    sidebarPreferences: {
      writable: true,
      refresh: vi.fn(async () => {}),
      snapshot: () => ({
        status: "ready",
        data: { sections: [{ id: "work", name: "Work" }], assignments: {} },
      }),
    },
    channelKit: { refresh: vi.fn(async () => {}), snapshot: () => kit },
  };
  return { session: session as unknown as RelaySession, kit };
}
it("loads exact project defaults and blocks when the catalog fails", async () => {
  const f = fixture();
  f.kit.entries = [
    {
      eventId: "head",
      record: {
        value: {
          type: "template",
          id: await projectTemplateId("work"),
          canvas: "Work here",
          agents: [],
          teamIds: [],
        },
      },
    },
  ];
  expect(await loadChatSetup(f.session, "work")).toEqual({
    projectId: "work",
    canvas: "Work here",
    agents: [],
    skipped: [],
    revision: "head",
  });
  f.kit.status = "error";
  await expect(loadChatSetup(f.session, "work")).rejects.toThrow(
    "defaults couldn’t load",
  );
});
it("names the saved defaults it read, even when they change while agents load", async () => {
  const f = fixture();
  const pubkey = "a".repeat(64);
  const template = (canvas: string) => ({
    type: "template",
    id: "",
    canvas,
    agents: [pubkey],
    teamIds: [],
  });
  const id = await projectTemplateId("work");
  f.kit.entries = [
    { eventId: "first", record: { value: { ...template("Old"), id } } },
  ];
  Object.assign(f.session, {
    agentChoices: {
      // Workspace settings save new defaults while the agents load.
      refresh: vi.fn(async () => {
        f.kit.entries = [
          { eventId: "second", record: { value: { ...template("New"), id } } },
        ];
      }),
      snapshot: () => ({
        templates: {
          status: "ready",
          complete: true,
          identities: [{ pubkey, name: "Agent", managed: false }],
        },
        identities: [],
        archives: { status: "ready", archived: [] },
      }),
    },
    channels: {
      refreshList: vi.fn(),
      list: () => ({ status: "ready", channels: [{ members: [pubkey] }] }),
    },
  });
  expect(await loadChatSetup(f.session, "work")).toMatchObject({
    canvas: "Old",
    revision: "first",
  });
});
it.each([
  "incomplete",
  "archived",
  "removed-legacy",
  "roster-loading",
  "eligible",
])("checks inherited agent eligibility: %s", async (state) => {
  const f = fixture();
  const pubkey = "a".repeat(64);
  let complete = state !== "incomplete";
  let rosterIncomplete = state.startsWith("roster-");
  const refreshRoster = vi.fn();
  f.kit.entries = [
    {
      record: {
        value: {
          type: "template",
          id: await projectTemplateId("work"),
          canvas: workspaceCanvas({ folders: ["/repo"], canvas: "Rules" }),
          agents: [pubkey],
          teamIds: [],
        },
      },
    },
  ];
  Object.assign(f.session, {
    agentChoices: {
      refresh: vi.fn(async () => {}),
      snapshot: () => ({
        templates: {
          status: "ready",
          complete,
          identities: [{ pubkey, name: "Agent", managed: false }],
        },
        identities: [],
        archives: {
          status: "ready",
          archived: state === "archived" ? [pubkey] : [],
        },
      }),
    },
    channels: {
      refreshList: refreshRoster,
      list: () => ({
        status: rosterIncomplete ? "loading" : "ready",
        coverage: undefined,
        channels:
          state === "removed-legacy" || rosterIncomplete
            ? []
            : [{ members: [pubkey] }],
      }),
    },
  });
  if (state === "eligible")
    expect(await loadChatSetup(f.session, "work")).toMatchObject({
      agents: [pubkey],
      skipped: [],
    });
  // An agent not available here is skipped, and the create still goes on.
  else if (state === "archived" || state === "removed-legacy") {
    expect(await loadChatSetup(f.session, "work")).toMatchObject({
      agents: [],
      skipped: [pubkey],
    });
    // A new channel gets the same agents, and only the shareable Canvas.
    expect(await loadChannelSetup(f.session, "work")).toEqual({
      canvas: "Rules",
      agents: [],
      skipped: [pubkey],
    });
  }
  // One not yet checked is neither: the start waits.
  else
    await expect(loadChatSetup(f.session, "work")).rejects.toThrow(
      "couldn’t load",
    );
  if (state === "incomplete" || rosterIncomplete) {
    if (rosterIncomplete) expect(refreshRoster).toHaveBeenCalledOnce();
    complete = true;
    rosterIncomplete = false;
    expect(await loadChatSetup(f.session, "work")).toMatchObject({
      agents: [pubkey],
    });
  }
});

it("prints a generated workspace block again for the agent, by where the conversation works", () => {
  const worktree = { location: "~/trees", baseBranch: "main" };
  const saved = workspaceCanvas({
    folders: ["/repo"],
    worktree,
    canvas: "Notes",
  });
  expect(agentCanvas(saved)).toBe(
    [
      "## Workspace instructions",
      "",
      "- Use `/repo` for review only. Do not make changes directly in it.",
      "- Before starting new work, fetch the latest `main` branch from origin.",
      "- For each repository that needs changes, create a new worktree under `~/trees` from `origin/main`.",
      "- Make code changes in that new worktree. A task that only reads code, or does not use a repository, usually does not need one.",
      // Follow-up work keeps its branch, which Canvases do not hold.
      "- These steps are for new work. For follow-up work on an existing branch or pull request, keep using that branch: reuse its linked worktree, or add one under `~/trees` if it has none.",
      "",
      "Notes",
    ].join("\n"),
  );
  expect(saved).not.toContain("These steps are for new work.");
  // A Canvas saved with the earlier rule reads the same.
  expect(
    agentCanvas(
      saved.replace(
        /- Make code changes.*/,
        "- Make all changes in that new worktree.",
      ),
    ),
  ).toBe(agentCanvas(saved));
  // The conversation has its own folder: no rule to make another worktree.
  expect(agentCanvas(saved, true)).toBe(
    "## Project folders\n\n- `/repo`\n\nNotes",
  );

  const folders = workspaceCanvas({ folders: ["/repo"], canvas: "Notes" });
  // Without the worktree setting, the working location rule applies to the
  // folders, as before: the block only lists them.
  expect(agentCanvas(folders)).toBe("## Project folders\n\n- `/repo`\n\nNotes");
  expect(agentCanvas(folders, true)).toBe(
    "## Project folders\n\n- `/repo`\n\nNotes",
  );
  expect(readWorkspace(folders).canvas).toBe("Notes");
});

it("keeps a workspace block the owner edited, and says so when it replaces the conversation's rule", () => {
  const edited = workspaceCanvas({
    folders: ["/repo"],
    worktree: { location: "~/trees", baseBranch: "main" },
    canvas: "Notes",
  }).replace("for review only", "for small fixes");
  expect(agentCanvas(edited)).toBe(edited);
  expect(agentCanvas(edited, true)).toBe(
    edited.replace(
      "\n\nNotes",
      "\n\nThe owner wrote the worktree rules of this block. They replace this conversation's working-location rule.\n\nNotes",
    ),
  );
  // An edited block without worktree rules has none to replace it with.
  const note = workspaceCanvas({ folders: ["/repo"], canvas: "Notes" }).replace(
    "- `/repo`",
    "- `/repo` (the API)",
  );
  expect(agentCanvas(note)).toBe(note);
  expect(agentCanvas(note, true)).toBe(note);
  for (const canvas of [
    "# Plain Canvas",
    "<!-- buzz-session-workspace:v1 broken",
    '<!-- buzz-session-workspace:v1 {"folders":[]} -->\n<!-- /buzz-session-workspace -->\n\nNotes',
  ]) {
    expect(agentCanvas(canvas)).toBe(canvas);
    expect(agentCanvas(canvas, true)).toBe(canvas);
  }
});

it("finds an agent's folders even in a hand-edited workspace block", () => {
  const canvas = workspaceCanvas({
    folders: ["/repo", "~/two"],
    worktree: { location: "~/trees", baseBranch: "main" },
    canvas: "Notes",
  });
  expect(workspaceDirectories(canvas)).toEqual(["/repo", "~/two", "~/trees"]);
  expect(
    workspaceDirectories(canvas.replace("for review only", "freely")),
  ).toEqual(["/repo", "~/two", "~/trees"]);
  expect(workspaceDirectories("# Plain Canvas")).toEqual([]);
  expect(workspaceDirectories("<!-- buzz-session-workspace:v1 broken")).toEqual(
    [],
  );
});

it.each([
  ["a canonical block", (block: string) => block, "Ship notes"],
  [
    "an introduction before the block",
    (block: string) => `Intro\n\n${block}`,
    "",
  ],
  ["a leading blank line", (block: string) => `\n${block}`, ""],
  ["a nested block", (block: string) => `Ship notes\n\n${block}`, ""],
  ["a malformed block", (block: string) => block.slice(0, 40), ""],
  ["plain instructions", () => "Just notes", "Just notes"],
])(
  "shares only metadata-free workspace instructions: %s",
  (_, shape, shared) => {
    const block = workspaceCanvas({
      folders: ["/private/project"],
      worktree: { location: "/private/worktrees", baseBranch: "main" },
      canvas: "Ship notes",
    });
    const result = shareableInstructions(shape(block));
    expect(result).toBe(shared);
    expect(result).not.toContain("/private");
  },
);
