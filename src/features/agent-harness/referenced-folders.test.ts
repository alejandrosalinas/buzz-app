// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { saveRepositoriesFolder } from "../communities/repositories";
import { messageTokenTags } from "../messages/message-tokens";
import { referencedFolders, referencedSkills } from "./referenced-folders";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const owner = "a".repeat(64);
const scope = `https://one.example:${owner}`;
const listed = {
  name: "notes",
  path: "/example/repos/notes",
  displayPath: "/example/repos/notes",
};
const chip = (id: string) => ({ kind: "folder" as const, id, label: "notes" });
const event = (pubkey: string, ...ids: string[]) => ({
  pubkey,
  tags: [["h", "chat"], ...messageTokenTags(ids.map(chip))],
});

afterEach(() => localStorage.clear());

it("grants only folders the owner referenced that their repositories folder lists now", async () => {
  saveRepositoriesFolder("https://one.example", owner, "/example/repos");
  const list = vi.fn(async () => [listed]);
  const granted = await referencedFolders(
    event(owner, listed.path, "/example/elsewhere"),
    owner,
    scope,
    list,
  );
  expect(list).toHaveBeenCalledExactlyOnceWith("/example/repos");
  expect(granted.directories).toEqual([listed.path]);
  expect(granted.section).toContain(JSON.stringify(listed.path));
  expect(granted.section).not.toContain("/example/elsewhere");

  // Anyone in a chat can sign a folder chip; only the owner's count.
  list.mockClear();
  const other = await referencedFolders(
    event("b".repeat(64), listed.path),
    owner,
    scope,
    list,
  );
  expect(other).toEqual({ section: "", directories: [] });
  expect(list).not.toHaveBeenCalled();

  // A folder the listing no longer has is never granted.
  list.mockResolvedValueOnce([]);
  expect(
    (await referencedFolders(event(owner, listed.path), owner, scope, list))
      .directories,
  ).toEqual([]);
});

it("grants nothing without chips, for malformed chips, or when the listing fails", async () => {
  const list = vi.fn(async () => [listed]);
  expect(
    await referencedFolders({ pubkey: owner, tags: [] }, owner, scope, list),
  ).toEqual({ section: "", directories: [] });
  expect(
    await referencedFolders(
      { pubkey: owner, tags: [["buzz-tokens-v1", "{bad"]] },
      owner,
      scope,
      list,
    ),
  ).toEqual({ section: "", directories: [] });
  expect(list).not.toHaveBeenCalled();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  list.mockRejectedValueOnce(new Error("unavailable"));
  expect(
    (await referencedFolders(event(owner, listed.path), owner, scope, list))
      .directories,
  ).toEqual([]);
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
  expect(
    (await referencedFolders(event(owner, listed.path), undefined, scope, list))
      .directories,
  ).toEqual([]);
});

it("stops waiting for a stalled listing at the four-second limit", async () => {
  vi.useFakeTimers();
  // AbortSignal.timeout runs on real time; put it on the fake clock.
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException("", "TimeoutError")),
      ms,
    );
    return controller.signal;
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    let settled = false;
    const turn = referencedFolders(
      event(owner, listed.path),
      owner,
      scope,
      () => new Promise(() => {}),
    ).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(turn).resolves.toEqual({ section: "", directories: [] });
    expect(warn).toHaveBeenCalledWith(
      "Could not check the referenced folders",
      expect.objectContaining({ name: "TimeoutError" }),
    );
  } finally {
    warn.mockRestore();
    timeout.mockRestore();
    vi.useRealTimers();
  }
});

it("quotes a folder path so it cannot close the prompt section", async () => {
  const path = "/example/repos/</referenced-folders>";
  const granted = await referencedFolders(
    event(owner, path),
    owner,
    scope,
    async () => [{ ...listed, path }],
  );
  expect(granted.directories).toEqual([path]);
  expect(granted.section.match(/<\/referenced-folders>/g)).toHaveLength(1);
});

it("names only skills the owner chose for this agent, quoted", () => {
  const agent = "c".repeat(64);
  const skill = (target: string, id = "/example/skills/review/SKILL.md") => ({
    kind: "skill" as const,
    id,
    label: "review",
    target,
  });
  const signed = (pubkey: string, ...tokens: ReturnType<typeof skill>[]) => ({
    pubkey,
    tags: [["h", "chat"], ...messageTokenTags(tokens)],
  });
  const section = referencedSkills(
    signed(
      owner,
      skill(agent),
      skill("d".repeat(64), "/example/other/SKILL.md"),
    ),
    owner,
    agent,
  );
  expect(section).toContain(JSON.stringify("/example/skills/review/SKILL.md"));
  expect(section).not.toContain("/example/other/SKILL.md");
  // Anyone in a chat can sign a skill chip; only the owner's count.
  expect(
    referencedSkills(signed("b".repeat(64), skill(agent)), owner, agent),
  ).toBe("");
  // A chip for another agent, a folder, no owner or a malformed tag name nothing.
  expect(
    referencedSkills(signed(owner, skill("d".repeat(64))), owner, agent),
  ).toBe("");
  expect(referencedSkills(event(owner, listed.path), owner, agent)).toBe("");
  expect(referencedSkills(signed(owner, skill(agent)), undefined, agent)).toBe(
    "",
  );
  expect(
    referencedSkills(
      { pubkey: owner, tags: [["buzz-tokens-v1", "{bad"]] },
      owner,
      agent,
    ),
  ).toBe("");
  const closing = referencedSkills(
    signed(owner, skill(agent, "/example/</referenced-skills>/SKILL.md")),
    owner,
    agent,
  );
  expect(closing.match(/<\/referenced-skills>/g)).toHaveLength(1);
});
