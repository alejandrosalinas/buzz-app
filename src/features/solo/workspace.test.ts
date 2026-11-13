import { expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import {
  LIVE_CANVAS_BYTES,
  LIVE_CANVAS_LIMIT,
  parseKitRecord,
} from "../channel-templates/model";
import {
  validateWorkspace,
  loadChatSetup,
  readWorkspace,
  projectTemplateId,
  workspaceCanvas,
  workspaceDirectories,
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
    soloPreferences: {
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
          canvas: "",
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
    });
  else
    await expect(loadChatSetup(f.session, "work")).rejects.toThrow(
      state === "incomplete" || rosterIncomplete
        ? "couldn’t load"
        : "unavailable",
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
