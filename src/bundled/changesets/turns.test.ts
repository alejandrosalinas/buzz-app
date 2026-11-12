// @vitest-environment node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalWork } from "../../features/agents/local-activity";
import type { RelaySession } from "../../features/relay/session";
import { workspaceCanvas } from "../../features/solo/workspace";
import type { Git } from "./git";
import { only, realGit, repo, sh } from "./testing";
import { KEEP, TURNS_KEY, type Turn, createTurns } from "./turns";

const canvases = new Map<string, string>();
vi.mock("../../features/agent-harness/project", () => ({
  ownerCanvas: async (_canvas: unknown, _owner: string, channelId: string) =>
    canvases.get(channelId),
}));

const storage = (initial: Record<string, string> = {}): Storage => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
};

function world(
  execution: Record<string, "local" | "remote"> = { A: "local", B: "local" },
) {
  const listeners = new Set<() => void>();
  let local: LocalWork[] = [];
  const session = {
    viewer: "me",
    canvas: {},
    agentChoices: {
      snapshot: () => ({
        identities: Object.entries(execution).map(([pubkey, mode]) => ({
          pubkey,
          execution: mode,
        })),
      }),
    },
    agentActivity: {
      activate: () => () => {},
      snapshot: () => ({ local }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
  } as unknown as RelaySession;
  const real = realGit();
  let snapshots = 0;
  let delay = 0;
  const git: Git = async (args, options) => {
    if (delay && args.includes("write-tree"))
      await new Promise((done) => setTimeout(done, delay));
    const out = await real(args, options);
    if (args.includes("write-tree")) snapshots++;
    return out;
  };
  return {
    session,
    git,
    snapshots: () => snapshots,
    slowSnapshots(ms: number) {
      delay = ms;
    },
    set(
      agent: string,
      id: string,
      state: LocalWork["state"],
      channelId = "c",
      extra: Partial<LocalWork> = {},
    ) {
      local = [
        ...local.filter((row) => row.messageId !== id),
        {
          scope: "s",
          agent,
          channelId,
          messageId: id,
          threadRootId: "",
          state,
          startedAt: 1,
          ...extra,
        },
      ];
      for (const listener of listeners) listener();
    },
  };
}

const NOW = () => Date.now();
const stored = (store: Storage): { id: string }[] =>
  JSON.parse(store.getItem(TURNS_KEY) ?? "[]");
afterEach(() => canvases.clear());

describe("createTurns", () => {
  it("records a local turn's changes and shows them on the agent's last reply", async () => {
    const dir = repo();
    canvases.set("c", workspaceCanvas({ folders: [dir], canvas: "" }));
    const w = world();
    const turns = createTurns(w.git, storage());
    const stop = turns.watch(w.session, "https://relay.example");
    w.set("A", "req", "working");
    await vi.waitFor(() => expect(w.snapshots()).toBe(1));
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    writeFileSync(join(dir, "new.txt"), "n\n");
    w.set("A", "req", "done");
    await vi.waitFor(() => expect(w.snapshots()).toBe(2));
    await vi.waitFor(() => expect(turns.version()).toBeGreaterThanOrEqual(2));
    turns.claim({
      id: "m1",
      authorId: "A",
      channelId: "c",
      createdAt: 0,
      createdAtMs: NOW(),
    });
    const turn = only(turns.cardsFor("m1"));
    expect(turn?.checkouts[0]?.files).toBe(2);
    const files = await turns.summary(turn.id, 0);
    expect(files.map((f) => f.path)).toEqual(["a.txt", "new.txt"]);
    const patch = await turns.patch(turn.id, 0, only(files));
    expect(patch).toContain("+two");
    stop();
  });

  it("gives the card to the later of two replies in one turn", async () => {
    const dir = repo();
    canvases.set("c", workspaceCanvas({ folders: [dir], canvas: "" }));
    const w = world();
    const turns = createTurns(w.git, storage());
    turns.watch(w.session, "https://relay.example");
    w.set("A", "req", "working");
    await vi.waitFor(() => expect(w.snapshots()).toBe(1));
    writeFileSync(join(dir, "n.txt"), "n\n");
    const first = NOW();
    turns.claim({
      id: "m1",
      authorId: "A",
      channelId: "c",
      createdAt: 0,
      createdAtMs: first,
    });
    turns.claim({
      id: "m2",
      authorId: "A",
      channelId: "c",
      createdAt: 0,
      createdAtMs: first + 5,
    });
    w.set("A", "req", "done");
    await vi.waitFor(() => expect(w.snapshots()).toBe(2));
    await vi.waitFor(() => expect(turns.cardsFor("m2")).toHaveLength(1));
    expect(turns.cardsFor("m1")).toEqual([]);
  });

  it("shows nothing for a turn that changed nothing", async () => {
    const dir = repo();
    canvases.set("c", workspaceCanvas({ folders: [dir], canvas: "" }));
    const w = world();
    const turns = createTurns(w.git, storage());
    turns.watch(w.session, "https://relay.example");
    w.set("A", "req", "working");
    await vi.waitFor(() => expect(w.snapshots()).toBe(1));
    w.set("A", "req", "done");
    await vi.waitFor(() => expect(w.snapshots()).toBe(2));
    turns.claim({
      id: "m1",
      authorId: "A",
      channelId: "c",
      createdAt: 0,
      createdAtMs: NOW(),
    });
    expect(turns.cardsFor("m1")).toEqual([]);
  });

  it("ignores an agent that runs remotely or on another machine", async () => {
    const dir = repo();
    canvases.set("c", workspaceCanvas({ folders: [dir], canvas: "" }));
    const w = world({ A: "remote" });
    const spawned = vi.fn(w.git);
    const turns = createTurns(spawned, storage());
    turns.watch(w.session, "https://relay.example");
    w.set("A", "req", "working");
    w.set("Elsewhere", "req2", "working");
    writeFileSync(join(dir, "n.txt"), "n\n");
    w.set("A", "req", "done");
    w.set("Elsewhere", "req2", "done");
    await new Promise((done) => setTimeout(done, 50));
    expect(spawned).not.toHaveBeenCalled();
    turns.claim({
      id: "m1",
      authorId: "A",
      channelId: "c",
      createdAt: 0,
      createdAtMs: NOW(),
    });
    expect(turns.cardsFor("m1")).toEqual([]);
  });

  it("does nothing in a chat without project folders", async () => {
    const w = world();
    const spawned = vi.fn(w.git);
    const turns = createTurns(spawned, storage());
    turns.watch(w.session, "https://relay.example");
    w.set("A", "req", "working");
    w.set("A", "req", "done");
    await new Promise((done) => setTimeout(done, 50));
    expect(spawned).not.toHaveBeenCalled();
  });

  it("does not track work that was already going when it started", async () => {
    const dir = repo();
    canvases.set("c", workspaceCanvas({ folders: [dir], canvas: "" }));
    const w = world();
    w.set("A", "req", "working");
    const spawned = vi.fn(w.git);
    const turns = createTurns(spawned, storage());
    turns.watch(w.session, "https://relay.example");
    w.set("A", "req", "done");
    await new Promise((done) => setTimeout(done, 50));
    expect(spawned).not.toHaveBeenCalled();
  });

  it("marks a card whose checkout another local agent was changing too", async () => {
    const dir = repo();
    canvases.set("c", workspaceCanvas({ folders: [dir], canvas: "" }));
    canvases.set("d", workspaceCanvas({ folders: [dir], canvas: "" }));
    const w = world();
    const turns = createTurns(w.git, storage());
    turns.watch(w.session, "https://relay.example");
    w.set("A", "r1", "working", "c");
    await vi.waitFor(() => expect(w.snapshots()).toBe(1));
    w.set("B", "r2", "working", "d");
    await vi.waitFor(() => expect(w.snapshots()).toBe(2));
    writeFileSync(join(dir, "n.txt"), "n\n");
    w.set("A", "r1", "done", "c");
    w.set("B", "r2", "done", "d");
    await vi.waitFor(() => expect(w.snapshots()).toBe(4));
    await vi.waitFor(() => expect(turns.version()).toBeGreaterThanOrEqual(3));
    const at = NOW();
    turns.claim({
      id: "ma",
      authorId: "A",
      channelId: "c",
      createdAt: 0,
      createdAtMs: at,
    });
    turns.claim({
      id: "mb",
      authorId: "B",
      channelId: "d",
      createdAt: 0,
      createdAtMs: at,
    });
    expect(turns.cardsFor("ma")[0]?.checkouts[0]?.shared).toBe(true);
    expect(turns.cardsFor("mb")[0]?.checkouts[0]?.shared).toBe(true);
  });

  it("shows another account's cards to no one else", async () => {
    const dir = repo();
    canvases.set("c", workspaceCanvas({ folders: [dir], canvas: "" }));
    const w = world();
    const store = storage();
    const mine = createTurns(w.git, store);
    mine.watch(w.session, "https://relay.example");
    w.set("A", "req", "working");
    await vi.waitFor(() => expect(w.snapshots()).toBe(1));
    writeFileSync(join(dir, "n.txt"), "n\n");
    w.set("A", "req", "done");
    await vi.waitFor(() => expect(w.snapshots()).toBe(2));
    await vi.waitFor(() => {
      mine.flush();
      expect(store.getItem(TURNS_KEY)).not.toBeNull();
    });
    const other = createTurns(w.git, store);
    other.watch(
      { ...w.session, viewer: "someone-else" } as RelaySession,
      "https://relay.example",
    );
    other.claim({
      id: "m1",
      authorId: "A",
      channelId: "c",
      createdAt: 0,
      createdAtMs: NOW(),
    });
    expect(other.cardsFor("m1")).toEqual([]);
    const again = createTurns(w.git, store);
    again.watch(w.session, "https://relay.example");
    expect(again.find(only(stored(store)).id, 0)).toBeDefined();
  });

  it("keeps the latest turns in storage and ignores damaged records", async () => {
    const dir = repo();
    canvases.set("c", workspaceCanvas({ folders: [dir], canvas: "" }));
    const old = Array.from({ length: KEEP + 20 }, (_, n) => ({
      id: `t${n}`,
      agent: "A",
      channelId: "c",
      viewer: "me",
      origin: "https://relay.example",
      start: n,
      end: n + 1,
      message: { id: `m${n}`, at: n },
      checkouts: [
        {
          dir,
          prefix: "",
          label: "x",
          before: "a".repeat(40),
          after: "b".repeat(40),
          files: 1,
        },
      ],
    }));
    const store = storage({
      [TURNS_KEY]: JSON.stringify([...old, { id: 5 }, null, "x"]),
    });
    const w = world();
    const turns = createTurns(w.git, store);
    turns.watch(w.session, "https://relay.example");
    w.set("A", "req", "working");
    await vi.waitFor(() => expect(w.snapshots()).toBe(1));
    writeFileSync(join(dir, "n.txt"), "n\n");
    w.set("A", "req", "done");
    await vi.waitFor(() => expect(w.snapshots()).toBe(2));
    await vi.waitFor(() => {
      turns.flush();
      expect(stored(store)).toHaveLength(KEEP);
    });
  });

  it("survives unreadable storage", () => {
    const w = world();
    expect(() =>
      createTurns(w.git, storage({ [TURNS_KEY]: "{" })),
    ).not.toThrow();
  });
});

const seeded = (
  id: string,
  extra: Partial<Turn> & { start: number; end: number },
): Turn => ({
  id,
  agent: "A",
  channelId: "c",
  viewer: "me",
  origin: "https://relay.example",
  checkouts: [
    {
      dir: "/x",
      prefix: "",
      label: "x",
      before: "a".repeat(40),
      after: "b".repeat(40),
      files: 1,
    },
  ],
  ...extra,
});
const reply = (id: string, at: number, threadRootId?: string) => ({
  id,
  authorId: "A",
  channelId: "c",
  createdAt: 0,
  createdAtMs: at,
  ...(threadRootId ? { threadRootId } : {}),
});

describe("matching replies to turns", () => {
  const turnsWith = (list: Turn[]) => {
    const turns = createTurns(
      realGit(),
      storage({ [TURNS_KEY]: JSON.stringify(list) }),
    );
    turns.watch(world().session, "https://relay.example");
    return turns;
  };

  it("keeps a thread's reply off an overlapping channel-level turn", () => {
    const turns = turnsWith([
      seeded("thread", { start: 0, end: 100_000, thread: "root" }),
      seeded("channel", { start: 50_000, end: 150_000 }),
    ]);
    turns.claim(reply("in-thread", 105_000, "root"));
    turns.claim(reply("in-channel", 140_000));
    expect(turns.cardsFor("in-thread").map((t) => t.id)).toEqual(["thread"]);
    expect(turns.cardsFor("in-channel").map((t) => t.id)).toEqual(["channel"]);
  });

  it("gives a message to the turn whose run published it, whatever the times", () => {
    const turns = turnsWith([
      seeded("early", { start: 0, end: 10_000 }),
      seeded("late", { start: 500_000, end: 600_000, published: ["m"] }),
    ]);
    turns.claim(reply("m", 5_000));
    expect(turns.cardsFor("m").map((t) => t.id)).toEqual(["late"]);
  });

  it("learns what a run published from its activity", async () => {
    const dir = repo();
    canvases.set("c", workspaceCanvas({ folders: [dir], canvas: "" }));
    const w = world();
    const turns = createTurns(w.git, storage());
    turns.watch(w.session, "https://relay.example");
    w.set("A", "req", "working");
    await vi.waitFor(() => expect(w.snapshots()).toBe(1));
    writeFileSync(join(dir, "n.txt"), "n\n");
    w.set("A", "req", "working", "c", { publishedMessageIds: ["p1"] });
    w.set("A", "req", "done", "c", { publishedMessageIds: ["p1"] });
    await vi.waitFor(() => expect(w.snapshots()).toBe(2));
    turns.claim(reply("p1", NOW() + 3_600_000));
    await vi.waitFor(() => expect(turns.cardsFor("p1")).toHaveLength(1));
  });
});

describe("watching across rebinding", () => {
  it("carries a running turn over to the replacement watcher", async () => {
    const dir = repo();
    canvases.set("c", workspaceCanvas({ folders: [dir], canvas: "" }));
    const w = world();
    const turns = createTurns(w.git, storage());
    const first = turns.watch(w.session, "https://relay.example");
    w.set("A", "req", "working");
    await vi.waitFor(() => expect(w.snapshots()).toBe(1));
    first();
    turns.watch({ ...w.session } as RelaySession, "https://relay.example");
    writeFileSync(join(dir, "n.txt"), "n\n");
    w.set("A", "req", "done");
    await vi.waitFor(() => expect(w.snapshots()).toBe(2));
    turns.claim(reply("m1", NOW()));
    await vi.waitFor(() => expect(turns.cardsFor("m1")).toHaveLength(1));
  });

  it("drops a turn the replacement no longer sees, so later turns are not marked shared", async () => {
    const dir = repo();
    canvases.set("c", workspaceCanvas({ folders: [dir], canvas: "" }));
    const old = world();
    const turns = createTurns(old.git, storage());
    const release = turns.watch(old.session, "https://relay.example");
    old.set("A", "req", "working");
    await vi.waitFor(() => expect(old.snapshots()).toBe(1));
    release();
    const fresh = world();
    turns.watch(fresh.session, "https://relay.example");
    fresh.set("B", "solo", "working");
    await vi.waitFor(() => expect(old.snapshots()).toBe(2));
    writeFileSync(join(dir, "n.txt"), "n\n");
    fresh.set("B", "solo", "done");
    await vi.waitFor(() => expect(old.snapshots()).toBe(3));
    turns.claim({ ...reply("mb", NOW()), authorId: "B" });
    await vi.waitFor(() => expect(turns.cardsFor("mb")).toHaveLength(1));
    expect(turns.cardsFor("mb")[0]?.checkouts[0]?.shared).toBeUndefined();
  });

  it("drops in-flight turns when the account changes", async () => {
    const dir = repo();
    canvases.set("c", workspaceCanvas({ folders: [dir], canvas: "" }));
    const old = world();
    const turns = createTurns(old.git, storage());
    turns.watch(old.session, "https://relay.example");
    old.set("A", "req", "working");
    await vi.waitFor(() => expect(old.snapshots()).toBe(1));
    const fresh = world();
    turns.watch(
      { ...fresh.session, viewer: "someone-else" } as RelaySession,
      "https://relay.example",
    );
    fresh.set("B", "solo", "working");
    await vi.waitFor(() => expect(old.snapshots()).toBe(2));
    writeFileSync(join(dir, "n.txt"), "n\n");
    fresh.set("B", "solo", "done");
    await vi.waitFor(() => expect(old.snapshots()).toBe(3));
    turns.claim({ ...reply("mb", NOW()), authorId: "B" });
    await vi.waitFor(() => expect(turns.cardsFor("mb")).toHaveLength(1));
    expect(turns.cardsFor("mb")[0]?.checkouts[0]?.shared).toBeUndefined();
  });
});

describe("worktrees and slow baselines", () => {
  it("includes a worktree the agent created during the turn", async () => {
    const dir = repo();
    canvases.set("c", workspaceCanvas({ folders: [dir], canvas: "" }));
    const w = world();
    const turns = createTurns(w.git, storage());
    turns.watch(w.session, "https://relay.example");
    w.set("A", "req", "working");
    await vi.waitFor(() => expect(w.snapshots()).toBe(1));
    const side = `${dir}-side`;
    sh(dir, "worktree", "add", "-q", "-b", "side", side);
    mkdirSync(side, { recursive: true });
    writeFileSync(join(side, "made.txt"), "m\n");
    writeFileSync(join(side, "a.txt"), "one\nedited\n");
    sh(side, "add", "--all");
    sh(side, "commit", "-q", "-m", "in the new worktree");
    w.set("A", "req", "done");
    await vi.waitFor(() => expect(w.snapshots()).toBe(3));
    turns.claim(reply("m1", NOW()));
    await vi.waitFor(() => expect(turns.cardsFor("m1")).toHaveLength(1));
    const turn = only(turns.cardsFor("m1"));
    const index = turn.checkouts.findIndex((c) => c.dir === side);
    expect(index).toBeGreaterThan(0);
    const files = await turns.summary(turn.id, index);
    expect(files.map((f) => f.path)).toEqual(["a.txt", "made.txt"]);
    expect(turn.checkouts[0]?.files).toBe(0);
  });

  it("keeps a new worktree to the folder the chat opened", async () => {
    const dir = repo({ "pkg/a.txt": "x\n", "other/b.txt": "y\n" });
    canvases.set(
      "c",
      workspaceCanvas({ folders: [join(dir, "pkg")], canvas: "" }),
    );
    const w = world();
    const turns = createTurns(w.git, storage());
    turns.watch(w.session, "https://relay.example");
    w.set("A", "req", "working");
    await vi.waitFor(() => expect(w.snapshots()).toBe(1));
    const side = `${dir}-side`;
    sh(dir, "worktree", "add", "-q", "-b", "side", side);
    writeFileSync(join(side, "pkg/a.txt"), "x2\n");
    writeFileSync(join(side, "other/b.txt"), "y2\n");
    w.set("A", "req", "done");
    await vi.waitFor(() => expect(w.snapshots()).toBe(3));
    turns.claim(reply("m1", NOW()));
    await vi.waitFor(() => expect(turns.cardsFor("m1")).toHaveLength(1));
    const turn = only(turns.cardsFor("m1"));
    const index = turn.checkouts.findIndex((c) => c.dir === side);
    expect(turn.checkouts[index]?.prefix).toBe("pkg/");
    const files = await turns.summary(turn.id, index);
    expect(files.map((f) => f.path)).toEqual(["pkg/a.txt"]);
  });

  it("marks a card whose first snapshot was slow", async () => {
    const dir = repo();
    canvases.set("c", workspaceCanvas({ folders: [dir], canvas: "" }));
    const w = world();
    w.slowSnapshots(1_700);
    const turns = createTurns(w.git, storage());
    turns.watch(w.session, "https://relay.example");
    w.set("A", "req", "working");
    await vi.waitFor(() => expect(w.snapshots()).toBe(1), { timeout: 5_000 });
    w.slowSnapshots(0);
    writeFileSync(join(dir, "n.txt"), "n\n");
    w.set("A", "req", "done");
    await vi.waitFor(() => expect(w.snapshots()).toBe(2));
    turns.claim(reply("m1", NOW()));
    await vi.waitFor(() => expect(turns.cardsFor("m1")).toHaveLength(1));
    expect(turns.cardsFor("m1")[0]?.checkouts[0]?.late).toBe(true);
  });
});
