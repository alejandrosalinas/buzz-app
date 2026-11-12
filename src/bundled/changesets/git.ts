import type { Host } from "../../features/host/service";
import { baseName, gitDirectory } from "./paths";

type Spawn = NonNullable<Host["spawn"]>;

const INDEX = "buzz.changesets.index";
const SCAN_INDEX = "buzz.changesets.scan";

/** Changed or new files one snapshot takes in; past it, it takes none. */
export const MAX_FILES = 1_000;
/** A file bigger than this is left out of snapshots. */
export const MAX_FILE_BYTES = 5 << 20;
/** As far as the Diff viewer parses one patch. */
export const MAX_PATCH_CHARS = 100_000;
const MAX_LIST_BYTES = 16 << 20;

const SAFE = [
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.quotepath=false",
];
const TREE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

type GitOptions = {
  env?: Record<string, string>;
  input?: string;
  limit?: number;
  timeout?: number;
};
export type Git = (
  args: readonly string[],
  options?: GitOptions,
) => Promise<string>;

/** A failure trying again cannot fix. */
export class Unreadable extends Error {}

/** Runs the manifest's `git` and returns its stdout. A run past its time or
 * output limit is killed, so one stuck repository stalls nothing else. */
export function createGit(spawn: Spawn): Git {
  return async (
    args,
    { env, input, limit = 1 << 20, timeout = 30_000 } = {},
  ) => {
    const out: string[] = [];
    const err: string[] = [];
    let size = 0;
    let stopped: "big" | "slow" | undefined;
    let running: Awaited<ReturnType<Spawn>> | undefined;
    const stop = (why: "big" | "slow") => {
      stopped ??= why;
      void running?.kill();
    };
    const child = await spawn("git", {
      args: [...SAFE, ...args],
      cwd: "~",
      env: {
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
        ...env,
      },
      onStdout(data) {
        size += data.length;
        if (size > limit) stop("big");
        else out.push(data);
      },
      onStderr: (data) => void (err.length < 64 && err.push(data)),
    });
    running = child;
    if (stopped) void child.kill();
    const timer = setTimeout(() => stop("slow"), timeout);
    await child.end(input).catch(() => {});
    const code = await child.exited.finally(() => clearTimeout(timer));
    if (stopped === "big")
      throw new Unreadable("This is too big to show here.");
    if (stopped === "slow") throw new Error("git took too long.");
    if (code !== 0)
      throw new Error(
        err.join("").trim().split("\n")[0] || `git exited with ${code}.`,
      );
    return out.join("");
  };
}

/** A working tree to snapshot, the part of it a chat's folder covers (empty
 * for all), and checkouts nested inside it to leave out. */
export type Checkout = {
  dir: string;
  prefix: string;
  label: string;
  skip?: string[];
};

/** Every checkout of the repository holding `folder`, worktrees included. */
export async function checkoutsOf(
  git: Git,
  folder: string,
): Promise<Checkout[]> {
  const [top, prefix = ""] = (
    await git([
      "-C",
      gitDirectory(folder),
      "rev-parse",
      "--show-toplevel",
      "--show-prefix",
    ])
  ).split("\n");
  if (!top) return [];
  const listing = await git([
    "-C",
    top,
    "worktree",
    "list",
    "--porcelain",
  ]).catch(() => `worktree ${top}\n`);
  const checkouts: Checkout[] = [];
  for (const block of listing.split("\n\n")) {
    const dir = /^worktree (.+)$/m.exec(block)?.[1];
    if (!dir || /^bare$/m.test(block) || /^prunable/m.test(block)) continue;
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    const name = baseName(dir);
    checkouts.push({
      dir,
      prefix,
      label: branch ? `${name} (${branch})` : name,
    });
  }
  if (!checkouts.length)
    checkouts.push({ dir: top, prefix, label: baseName(top) });
  return nest(checkouts);
}

/** A worktree inside another checkout would show there as one changed file. */
export function nest<T extends Checkout>(checkouts: T[]): T[] {
  for (const checkout of checkouts) {
    const inside = checkouts.filter((other) =>
      other.dir.startsWith(`${checkout.dir}/`),
    );
    if (inside.length)
      checkout.skip = inside.map((other) =>
        other.dir.slice(checkout.dir.length + 1),
      );
  }
  return checkouts;
}

/** The tree a worktree was created with, from the oldest entry of its HEAD's
 * reflog; undefined when git kept none. */
export async function startingTree(
  git: Git,
  dir: string,
): Promise<string | undefined> {
  const log = await git(["-C", dir, "reflog", "show", "--format=%H", "HEAD"]);
  const first = log.trim().split("\n").at(-1) ?? "";
  if (!TREE.test(first)) return undefined;
  const tree = (await git(["-C", dir, "rev-parse", `${first}^{tree}`])).trim();
  return TREE.test(tree) ? tree : undefined;
}

const scopeOf = ({ prefix, skip = [] }: Pick<Checkout, "prefix" | "skip">) => [
  `:(top,literal)${prefix}`,
  ...skip.map((path) => `:(top,literal,exclude)${path}`),
];
const split0 = (text: string) => text.split("\0").filter(Boolean);

const queues = new Map<string, Promise<unknown>>();
const seeded = new Set<string>();

/** The checkout's files as git would commit them now, untracked included and
 * ignored left out, as a tree id. One at a time per checkout: they share the
 * plugin's own index, which keeps its stat cache between snapshots and never
 * touches the index the person or agent stages with. */
export function snapshot(git: Git, checkout: Checkout): Promise<string> {
  const run = (queues.get(checkout.dir) ?? Promise.resolve()).then(() =>
    take(git, checkout),
  );
  queues.set(
    checkout.dir,
    run.catch(() => {}),
  );
  return run;
}

async function take(git: Git, checkout: Checkout): Promise<string> {
  const at = ["-C", checkout.dir];
  const gitDir = (await git([...at, "rev-parse", "--absolute-git-dir"])).trim();
  const env = { GIT_INDEX_FILE: `${gitDir}/${INDEX}` };
  // Start from HEAD once per run, so files git tracks are kept even when an
  // ignore rule matches them. An unborn branch has no HEAD.
  if (!seeded.has(gitDir)) {
    const head = (
      await git([...at, "rev-parse", "--verify", "-q", "HEAD^{tree}"]).catch(
        () => "",
      )
    ).trim();
    if (head) await git([...at, "read-tree", "-m", head], { env });
    seeded.add(gitDir);
  }
  await reconcileIgnored(git, at, gitDir, env);
  const changed = split0(
    await git(
      [
        ...at,
        "ls-files",
        "-z",
        "--others",
        "--modified",
        "--exclude-standard",
        "--",
        ...scopeOf(checkout),
      ],
      { env, limit: MAX_LIST_BYTES },
    ),
  );
  if (changed.length > MAX_FILES)
    throw new Error(`More than ${MAX_FILES} files changed.`);
  const large = changed.length
    ? await largeFiles(git, at, gitDir, changed)
    : [];
  await git(
    [...at, "add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"],
    {
      env,
      input: [
        ...scopeOf(checkout),
        ...large.map((path) => `:(top,literal,exclude)${path}`),
      ].join("\0"),
      timeout: 120_000,
    },
  );
  return (await git([...at, "write-tree"], { env })).trim();
}

/** Keeps the private index's ignored files to those git tracks: takes out
 * what an ignore rule now covers, and puts in what was force-added since,
 * since `add --all` only updates ignored files the index already holds. */
async function reconcileIgnored(
  git: Git,
  at: string[],
  gitDir: string,
  env: Record<string, string>,
) {
  const list = [
    "ls-files",
    "-z",
    "--cached",
    "--ignored",
    "--exclude-standard",
  ];
  const read = (extra: string[], options: { env?: Record<string, string> }) =>
    git([...at, ...list, ...extra], { ...options, limit: MAX_LIST_BYTES });
  const [held, tracked] = await Promise.all([
    read([], { env }).then((text) => new Set(split0(text))),
    read(["--with-tree=HEAD"], {})
      .catch(() => read([], {}))
      .then((text) => new Set(split0(text))),
  ]);
  const gone = [...held].filter((path) => !tracked.has(path));
  if (gone.length)
    await git([...at, "update-index", "--force-remove", "-z", "--stdin"], {
      env,
      input: `${gone.join("\0")}\0`,
    });
  const missing = [...tracked].filter((path) => !held.has(path));
  if (!missing.length) return;
  const large = new Set(await largeFiles(git, at, gitDir, missing));
  const added = missing.filter((path) => !large.has(path));
  if (added.length)
    await git([...at, "update-index", "--add", "--remove", "-z", "--stdin"], {
      env,
      input: `${added.join("\0")}\0`,
      timeout: 120_000,
    });
}

/** Which of `paths` are over the size limit. Git reads each size only after
 * hashing, so this hashes into a scratch index without writing any object. */
async function largeFiles(
  git: Git,
  at: string[],
  gitDir: string,
  paths: string[],
) {
  const env = { GIT_INDEX_FILE: `${gitDir}/${SCAN_INDEX}` };
  await git([...at, "read-tree", "--empty"], { env });
  await git(
    [
      ...at,
      "update-index",
      "--add",
      "--remove",
      "--info-only",
      "-z",
      "--stdin",
    ],
    { env, input: `${paths.join("\0")}\0`, timeout: 120_000 },
  );
  const entries = (
    await git([...at, "ls-files", "--debug", "-z"], {
      env,
      limit: MAX_LIST_BYTES,
    })
  ).split("\0");
  // Each name ends in NUL, then its stat lines; the next name follows them.
  const large: string[] = [];
  let name = entries[0] ?? "";
  for (const part of entries.slice(1)) {
    if (Number(/size: (\d+)/.exec(part)?.[1] ?? 0) > MAX_FILE_BYTES)
      large.push(name);
    name = part.slice(part.lastIndexOf("\n") + 1);
  }
  return large;
}

export type ChangedFile = {
  path: string;
  from?: string;
  status: "added" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
};
const STATUS = { A: "added", D: "deleted", R: "renamed" } as const;

const compare = (before: string, after: string) => {
  if (!TREE.test(before) || !TREE.test(after))
    throw new Error("Not a snapshot.");
  return ["--no-ext-diff", "--no-textconv", "--no-color", "-M", before, after];
};
const gone = (error: unknown): never => {
  const text = String(error);
  if (/bad object|unable to read tree|not a tree/i.test(text))
    throw new Unreadable("git has cleaned up this changeset's snapshots.");
  if (/cannot change to|No such file|not a git repository/i.test(text))
    throw new Unreadable("Its repository has moved or gone.");
  throw error;
};

/** Every file that differs between two snapshots, with its counts. */
export async function changedFiles(
  git: Git,
  checkout: Checkout,
  before: string,
  after: string,
): Promise<ChangedFile[]> {
  if (before === after) return [];
  const range = [...compare(before, after), "-z", "--", ...scopeOf(checkout)];
  const at = ["-C", checkout.dir, "diff"];
  const [names, numbers] = await Promise.all([
    git([...at, "--name-status", ...range]),
    git([...at, "--numstat", ...range]),
  ]).catch(gone);
  // STATUS\0path\0, or STATUS\0from\0path\0 for a rename.
  const name = names.split("\0");
  // added\tdeleted\tpath\0, or added\tdeleted\t\0from\0path\0; "-" for binary.
  const count = numbers.split("\0");
  const files: ChangedFile[] = [];
  for (let n = 0, c = 0; n < name.length - 1; c++) {
    const letter = name[n++]?.charAt(0) ?? "M";
    const from = letter === "R" ? name[n++] : undefined;
    const path = name[n++] ?? "";
    const [added = "0", deleted = "0", inline = ""] = (count[c] ?? "").split(
      "\t",
    );
    if (!inline) c += 2;
    const binary = added === "-";
    files.push({
      path,
      ...(from === undefined ? {} : { from }),
      status: STATUS[letter as keyof typeof STATUS] ?? "modified",
      additions: binary ? 0 : Number(added),
      deletions: binary ? 0 : Number(deleted),
      binary,
    });
  }
  return files;
}

/** One file's patch between two snapshots, as the Diff viewer reads it. */
export async function filePatch(
  git: Git,
  checkout: Checkout,
  before: string,
  after: string,
  file: ChangedFile,
): Promise<string> {
  const paths = [file.from, file.path]
    .filter((path) => path !== undefined)
    .map((path) => `:(top,literal)${path}`);
  return git(
    [
      "-C",
      checkout.dir,
      "diff",
      "--patch",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      ...compare(before, after),
      "--",
      ...paths,
    ],
    { limit: MAX_PATCH_CHARS },
  ).catch(gone);
}
