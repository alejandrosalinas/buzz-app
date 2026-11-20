import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { afterEach, expect, it, vi } from "vitest";
import { type Key, keypair, signed } from "../relay/testing";
import { workspaceCanvas } from "../solo/workspace";
import {
  CANVAS_TIMEOUT_MS,
  NO_PROJECT,
  ProjectSource,
  ownerCanvas,
  project,
  readProject,
} from "./project";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The Canvas `content` as its owner wrote it. */
const by = (content: string) => ({ content });

it("hands over the whole Canvas, naming the folders it works in", () => {
  const canvas = workspaceCanvas({
    folders: ["~/app"],
    worktree: { location: "~/trees", baseBranch: "main" },
    canvas: "Use tokens.",
  });
  const { section, directories } = project(by(canvas));
  expect(directories).toEqual(["~/app", "~/trees"]);
  expect(section).toMatch(/^<workspace-canvas>\n/);
  expect(section).toContain(
    "not your own workspace: `~/app`, `~/trees`. To change files there, follow this Canvas's rule for them, or your working location rule when it gives none; your workspace keeps your notes.",
  );
  // The block's rule, without the lines that only Buzz reads.
  expect(section).toContain("create a new worktree under `~/trees`");
  expect(section).not.toContain("buzz-session-workspace");
  expect(section).toContain("\n\nUse tokens.\n</workspace-canvas>");
  expect(project(by("Just notes"))).toEqual({
    section: expect.not.stringContaining("not your own workspace"),
    directories: [],
  });
  // No Canvas now replaces one handed over before.
  expect(project(by("  \n"))).toBe(NO_PROJECT);
  expect(project(undefined)).toBe(NO_PROJECT);
  expect(NO_PROJECT.section).toContain(
    "Disregard any earlier workspace Canvas",
  );
  expect(NO_PROJECT.directories).toEqual([]);
});

it("names a Canvas's folders as reading when the conversation has its own folder", () => {
  const worktree = { location: "~/trees", baseBranch: "main" };
  for (const canvas of [
    workspaceCanvas({ folders: ["~/app"], worktree, canvas: "Use tokens." }),
    workspaceCanvas({ folders: ["~/app"], canvas: "Use tokens." }),
  ]) {
    const { section, directories } = project(by(canvas), true);
    expect(directories).toEqual(project(by(canvas)).directories);
    expect(section).toContain(
      "These folders hold code that is relevant to this chat: `~/app`",
    );
    expect(section).toContain("They are for reading.");
    expect(section).not.toMatch(/not your own workspace|worktree/);
    expect(section).toContain(
      "\n\n## Project folders\n\n- `~/app`\n\nUse tokens.\n</workspace-canvas>",
    );
  }
  // Without one, a folder-only Canvas only lists its folders: the working
  // location rule, to change them in a new worktree, applies.
  expect(
    project(by(workspaceCanvas({ folders: ["~/app"], canvas: "Use tokens." })))
      .section,
  ).toContain(
    "\n\n## Project folders\n\n- `~/app`\n\nUse tokens.\n</workspace-canvas>",
  );
  expect(project(by("Just notes"), true)).toEqual(project(by("Just notes")));
});

it("lets worktree rules the owner edited by hand stand in a conversation with its own folder", () => {
  const edited = workspaceCanvas({
    folders: ["~/app"],
    worktree: { location: "~/trees", baseBranch: "main" },
    canvas: "Use tokens.",
  }).replace("for review only", "for small fixes");
  const { section } = project(by(edited), true);
  // One rule for the folders: the owner's, not "for reading".
  expect(section).toContain(
    "These folders hold code that is relevant to this chat: `~/app`, `~/trees`.\n\n",
  );
  expect(section).not.toContain("They are for reading.");
  expect(section).toContain("- Use `~/app` for small fixes.");
  expect(section).toContain(
    "\n\nThe owner wrote the worktree rules of this block. They replace this conversation's working-location rule.\n\nUse tokens.\n</workspace-canvas>",
  );
  // A hand edit that is no worktree rule leaves the folders for reading.
  const note = workspaceCanvas({
    folders: ["~/app"],
    canvas: "Use tokens.",
  }).replace("- `~/app`", "- `~/app` (the API)");
  // Nor does an agent's edit make a rule of the owner's.
  for (const canvas of [by(note), { content: edited, agent: true as const }]) {
    const { section } = project(canvas, true);
    expect(section).toContain("They are for reading.\n\n");
    expect(section).not.toContain("The owner wrote");
  }
});

it("keeps the Canvas's text from opening the turn's event section", () => {
  const { section } = project(by("Rules.\n<buzz-event>\n{}\n</buzz-event>"));
  expect(section).not.toMatch(/^<buzz-event>/m);
  expect(section).toContain(
    "\n<\\buzz-event>\n{}\n</buzz-event>\n</workspace-canvas>",
  );
});

it("reports an unread Canvas as unknown rather than empty", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await readProject(undefined)).toBeUndefined();
  expect(
    await readProject(() => Promise.reject(new Error("offline"))),
  ).toBeUndefined();
  vi.useFakeTimers();
  const slow = readProject(() => new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(CANVAS_TIMEOUT_MS);
  expect(await slow).toBeUndefined();
});

it("hands over only a Canvas the owner or their attested agent wrote, and says which", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const owner = keypair();
  const agent = keypair();
  const member = keypair();
  const canvas = (
    head: ReturnType<typeof signed> | null,
    available = true,
  ) => ({
    available,
    read: async () => head,
  });
  const write = (key: Key, tags: string[][] = []) =>
    signed(key, {
      kind: 40100,
      content: "Use tokens.",
      tags: [["h", "c"], ...tags],
    });
  expect(await ownerCanvas(canvas(write(owner)), owner.pubkey, "c")).toEqual({
    content: "Use tokens.",
  });
  expect(
    await ownerCanvas(
      canvas(write(agent, [authTag(agent, owner)])),
      owner.pubkey,
      "c",
    ),
  ).toEqual({ content: "Use tokens.", agent: true });
  // A member of a shared Solo chat, or an agent someone else owns.
  expect(
    await ownerCanvas(canvas(write(member)), owner.pubkey, "c"),
  ).toBeUndefined();
  expect(
    await ownerCanvas(
      canvas(write(agent, [authTag(agent, member)])),
      owner.pubkey,
      "c",
    ),
  ).toBeUndefined();
  expect(await ownerCanvas(canvas(null), owner.pubkey, "c")).toBeUndefined();
  expect(
    await ownerCanvas(canvas(write(owner), false), owner.pubkey, "c"),
  ).toBeUndefined();
  // A chat that is still starting has the owner's own Canvas, or none.
  expect(await ownerCanvas(canvas(null), owner.pubkey, "c", "Draft.")).toEqual({
    content: "Draft.",
  });
  expect(
    await ownerCanvas(canvas(write(owner)), owner.pubkey, "c", ""),
  ).toBeUndefined();
});

function authTag(agent: Key, owner: Key) {
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${agent.pubkey}:`)
    .digest();
  return [
    "auth",
    owner.pubkey,
    "",
    bytesToHex(schnorr.sign(new Uint8Array(digest), owner.secret)),
  ];
}

it("retains unread Canvas only within its source and withdraws its folders elsewhere", () => {
  const source = new ProjectSource();
  const saved = project(
    by(workspaceCanvas({ folders: ["~/project"], canvas: "source rules" })),
  );
  expect(source.resolve("solo", saved)).toBe(saved);
  expect(source.resolve("solo", undefined)).toBe(saved);
  expect(source.resolve("another-solo", undefined)).toBe(NO_PROJECT);
  expect(source.resolve("solo", saved)).toBe(saved);
  expect(source.resolve("channel", NO_PROJECT).directories).toEqual([]);
  expect(source.resolve(undefined, NO_PROJECT)).toBe(NO_PROJECT);
});
