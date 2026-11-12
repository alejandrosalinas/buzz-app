// @vitest-environment node
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePatch } from "../diffs/parse";
import {
  type Checkout,
  MAX_FILES,
  MAX_FILE_BYTES,
  changedFiles,
  checkoutsOf,
  filePatch,
  snapshot,
} from "./git";
import { only, realGit, repo, sh } from "./testing";

const git = realGit();
const here = (dir: string): Checkout => ({ dir, prefix: "", label: "t" });
const write = (dir: string, name: string, text: string | Buffer) => {
  mkdirSync(join(dir, name, ".."), { recursive: true });
  writeFileSync(join(dir, name), text);
};

describe("checkoutsOf", () => {
  it("labels the checkout with its folder and branch", async () => {
    const dir = repo();
    const [checkout, ...rest] = await checkoutsOf(git, dir);
    expect(rest).toEqual([]);
    expect(checkout).toMatchObject({ dir, prefix: "" });
    expect(checkout?.label).toMatch(/\(main\)$/);
  });

  it("keeps the folder's place inside the repository", async () => {
    const dir = repo({ "pkg/a.txt": "x\n" });
    const [checkout] = await checkoutsOf(git, join(dir, "pkg"));
    expect(checkout?.prefix).toBe("pkg/");
  });

  it("finds a linked worktree and leaves it out of the checkout that holds it", async () => {
    const dir = repo();
    sh(dir, "worktree", "add", "-q", "-b", "side", join(dir, "nested/side"));
    const found = await checkoutsOf(git, dir);
    expect(found.map((c) => c.dir)).toContain(join(dir, "nested/side"));
    expect(found.find((c) => c.dir === dir)?.skip).toEqual(["nested/side"]);
  });

  it("is empty outside a repository", async () => {
    await expect(checkoutsOf(git, "/")).rejects.toThrow();
  });
});

describe("snapshot and changedFiles", () => {
  it("lists what changed between two snapshots with counts", async () => {
    const dir = repo({ "a.txt": "one\ntwo\n", "gone.txt": "bye\n" });
    const c = here(dir);
    const before = await snapshot(git, c);
    write(dir, "a.txt", "one\nthree\nfour\n");
    write(dir, "new.txt", "hello\n");
    rmSync(join(dir, "gone.txt"));
    const after = await snapshot(git, c);
    const file = (
      path: string,
      status: string,
      additions: number,
      deletions: number,
    ) => ({
      path,
      status,
      additions,
      deletions,
      binary: false,
    });
    expect(await changedFiles(git, c, before, after)).toEqual([
      file("a.txt", "modified", 2, 1),
      file("gone.txt", "deleted", 0, 1),
      file("new.txt", "added", 1, 0),
    ]);
  });

  it("follows a rename and names where it came from", async () => {
    const dir = repo({ "old.txt": "a\nb\nc\nd\ne\nf\n" });
    const c = here(dir);
    const before = await snapshot(git, c);
    sh(dir, "mv", "old.txt", "new.txt");
    const after = await snapshot(git, c);
    expect(await changedFiles(git, c, before, after)).toEqual([
      {
        path: "new.txt",
        from: "old.txt",
        status: "renamed",
        additions: 0,
        deletions: 0,
        binary: false,
      },
    ]);
  });

  it("is empty when nothing changed", async () => {
    const c = here(repo());
    const a = await snapshot(git, c);
    const b = await snapshot(git, c);
    expect(a).toBe(b);
    expect(await changedFiles(git, c, a, b)).toEqual([]);
  });

  it("leaves the branch, the index and the working files alone", async () => {
    const dir = repo();
    const c = here(dir);
    write(dir, "a.txt", "changed\n");
    write(dir, "untracked.txt", "u\n");
    const status = sh(dir, "status", "--porcelain");
    const head = sh(dir, "rev-parse", "HEAD");
    await snapshot(git, c);
    expect(sh(dir, "status", "--porcelain")).toBe(status);
    expect(sh(dir, "diff", "--cached")).toBe("");
    expect(sh(dir, "rev-parse", "HEAD")).toBe(head);
  });

  it("counts untracked files and skips ignored ones", async () => {
    const dir = repo({ ".gitignore": "ignored.txt\nbuild/\n", "a.txt": "x\n" });
    const c = here(dir);
    const before = await snapshot(git, c);
    write(dir, "ignored.txt", "secret\n");
    write(dir, "build/out.js", "x\n");
    write(dir, "kept.txt", "k\n");
    const after = await snapshot(git, c);
    const files = await changedFiles(git, c, before, after);
    expect(files.map((f) => f.path)).toEqual(["kept.txt"]);
  });

  it("stops capturing a file once an ignore rule covers it, but keeps tracked ones", async () => {
    const dir = repo({ "tracked.log": "t0\n", "a.txt": "x\n" });
    const c = here(dir);
    write(dir, "secret.env", "key=1\n");
    await snapshot(git, c);
    write(dir, ".gitignore", "secret.env\n*.log\n");
    write(dir, "secret.env", "key=2-changed\n");
    write(dir, "tracked.log", "t1\n");
    const before = await snapshot(git, c);
    write(dir, "secret.env", "key=3-changed-again\n");
    write(dir, "tracked.log", "t2\n");
    const after = await snapshot(git, c);
    const files = await changedFiles(git, c, before, after);
    expect(files.map((f) => f.path)).toEqual(["tracked.log"]);
    expect(sh(dir, "ls-tree", "-r", "--name-only", after)).not.toContain(
      "secret.env",
    );
  });

  it("captures an ignored file once git tracks it", async () => {
    const dir = repo({ ".gitignore": "*.gen\n", "a.txt": "x\n" });
    const c = here(dir);
    write(dir, "out.gen", "g\n");
    const before = await snapshot(git, c);
    sh(dir, "add", "-f", "out.gen");
    sh(dir, "commit", "-q", "-m", "track it");
    const after = await snapshot(git, c);
    const files = await changedFiles(git, c, before, after);
    expect(files.map((f) => f.path)).toEqual(["out.gen"]);
  });

  it("covers only the folder a chat opened, when it is inside the repository", async () => {
    const dir = repo({ "pkg/a.txt": "x\n", "other/b.txt": "y\n" });
    const c: Checkout = { dir, prefix: "pkg/", label: "pkg" };
    const before = await snapshot(git, c);
    write(dir, "pkg/a.txt", "x2\n");
    write(dir, "other/b.txt", "y2\n");
    const after = await snapshot(git, c);
    expect(
      (await changedFiles(git, c, before, after)).map((f) => f.path),
    ).toEqual(["pkg/a.txt"]);
  });

  it("leaves out a nested checkout", async () => {
    const dir = repo();
    sh(dir, "worktree", "add", "-q", "-b", "side", join(dir, "side"));
    const c: Checkout = { dir, prefix: "", label: "t", skip: ["side"] };
    const before = await snapshot(git, c);
    write(dir, "side/inside.txt", "x\n");
    write(dir, "top.txt", "x\n");
    const after = await snapshot(git, c);
    expect(
      (await changedFiles(git, c, before, after)).map((f) => f.path),
    ).toEqual(["top.txt"]);
  });

  it("does not write a file over the size limit into the repository", async () => {
    const dir = repo();
    const c = here(dir);
    const before = await snapshot(git, c);
    write(dir, "huge.bin", Buffer.alloc(MAX_FILE_BYTES + 1, 1));
    write(dir, "small.txt", "ok\n");
    const after = await snapshot(git, c);
    const files = await changedFiles(git, c, before, after);
    expect(files.map((f) => f.path)).toEqual(["small.txt"]);
    const sizes = sh(dir, "cat-file", "--batch-all-objects", "--batch-check")
      .split("\n")
      .map((line) => Number(line.split(" ")[2] ?? 0));
    expect(Math.max(...sizes)).toBeLessThan(MAX_FILE_BYTES);
  }, 30_000);

  it("takes no snapshot when too many files changed", async () => {
    const dir = repo();
    const c = here(dir);
    await snapshot(git, c);
    for (let n = 0; n <= MAX_FILES; n++) write(dir, `many/f${n}.txt`, `${n}\n`);
    await expect(snapshot(git, c)).rejects.toThrow(/More than/);
  }, 60_000);

  it("flags binary files without counts", async () => {
    const dir = repo();
    const c = here(dir);
    const before = await snapshot(git, c);
    write(dir, "pic.bin", Buffer.from([0, 1, 2, 0, 255, 0, 0]));
    const after = await snapshot(git, c);
    expect(await changedFiles(git, c, before, after)).toEqual([
      {
        path: "pic.bin",
        status: "added",
        additions: 0,
        deletions: 0,
        binary: true,
      },
    ]);
  });

  it("handles unusual file names", async () => {
    const dir = repo();
    const c = here(dir);
    const before = await snapshot(git, c);
    write(dir, "sp ace/naïve – ü.txt", "x\n");
    write(dir, "-dash.txt", "x\n");
    const after = await snapshot(git, c);
    const paths = (await changedFiles(git, c, before, after)).map(
      (f) => f.path,
    );
    expect(paths).toEqual(["-dash.txt", "sp ace/naïve – ü.txt"]);
  });

  it("starts from an unborn branch", async () => {
    const dir = repo();
    sh(dir, "checkout", "-q", "--orphan", "fresh");
    sh(dir, "rm", "-rq", "--cached", ".");
    const c = here(dir);
    const first = await snapshot(git, c);
    expect(first).toMatch(/^[0-9a-f]{40}/);
  });

  it("says when git has cleaned up the snapshots", async () => {
    const dir = repo();
    const c = here(dir);
    const before = await snapshot(git, c);
    write(dir, "n.txt", "x\n");
    const after = await snapshot(git, c);
    sh(dir, "prune", "--expire=now");
    await expect(changedFiles(git, c, before, after)).rejects.toThrow(
      /cleaned up/,
    );
  });

  it("refuses anything that is not a snapshot id", async () => {
    const c = here(repo());
    await expect(
      changedFiles(git, c, "--output=/tmp/x", "HEAD"),
    ).rejects.toThrow(/Not a snapshot/);
  });
});

describe("filePatch", () => {
  it("returns one file's patch for the Diff viewer", async () => {
    const dir = repo({ "a.txt": "one\ntwo\n", "b.txt": "b\n" });
    const c = here(dir);
    const before = await snapshot(git, c);
    write(dir, "a.txt", "one\nthree\n");
    write(dir, "b.txt", "b2\n");
    const after = await snapshot(git, c);
    const file = only(await changedFiles(git, c, before, after));
    const patch = await filePatch(git, c, before, after, file);
    expect(patch).toContain("+three");
    expect(patch).not.toContain("b2");
    const parsed = parsePatch(patch);
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.newPath).toBe("a.txt");
  });

  it("includes both names of a rename", async () => {
    const dir = repo({ "old.txt": "a\nb\nc\nd\ne\nf\n" });
    const c = here(dir);
    const before = await snapshot(git, c);
    sh(dir, "mv", "old.txt", "new.txt");
    write(dir, "new.txt", "a\nb\nc\nd\ne\nf\ng\n");
    const after = await snapshot(git, c);
    const file = only(await changedFiles(git, c, before, after));
    const patch = await filePatch(git, c, before, after, file);
    expect(patch).toContain("rename from old.txt");
    expect(patch).toContain("+g");
  });

  it("refuses a patch past the Diff viewer's limit", async () => {
    const dir = repo();
    const c = here(dir);
    const before = await snapshot(git, c);
    write(dir, "big.txt", "line\n".repeat(30_000));
    const after = await snapshot(git, c);
    const file = only(await changedFiles(git, c, before, after));
    await expect(filePatch(git, c, before, after, file)).rejects.toThrow(
      /too big/,
    );
  });
});
