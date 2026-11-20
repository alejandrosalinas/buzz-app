import { describe, expect, it } from "vitest";
import type { ReadFilter, RelayEvent } from "../relay/events";
import { ARTIFACT_KIND, type SnapshotRead } from "./agent-config-artifacts";
import {
  emptyHistory,
  HISTORY_LIMIT,
  HISTORY_PAGE,
  type History,
  lineDiff,
  loadOlder,
  recalledHistory,
  rememberHistory,
  revertTemplate,
  revisionProblem,
  segments,
  settingsDiff,
} from "./agent-config-history";

const channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const d = "5b1d3b52-6c4e-5a0b-8e3c-1f2a3b4c5d6e";

/** A revision as the relay returns it; history display checks no signature. */
function rev(
  id: string,
  prev?: string,
  {
    op = prev ? "update" : "create",
    content = `{"version":1,"text":"${id}"}`,
    tags = [] as string[][],
    type = "buzz.agent.instructions",
    title = "Agent instructions",
  } = {},
): RelayEvent {
  return {
    id,
    pubkey: "a".repeat(64),
    sig: "b".repeat(128),
    kind: ARTIFACT_KIND,
    created_at: 1_700_000_000,
    content,
    tags: [
      ["ar", "1"],
      ["d", d],
      ["h", channel],
      ["type", type],
      ["title", title],
      ["op", op],
      ...(prev ? [["prev", prev]] : []),
      ...tags,
    ],
  } as RelayEvent;
}

/** A linear chain r0 ← r1 ← … ← r(n-1), newest first like the relay. */
const chain = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    rev(`r${i}`, i ? `r${i - 1}` : undefined),
  ).reverse();

/** Answers history pages from `revisions` (newest first) and records filters.
 * Like the relay for a system channel (NIP-CL), a filter whose `#h` doesn't
 * name the channel reads nothing. */
function relay(revisions: RelayEvent[]) {
  const filters: ReadFilter[] = [];
  const read: SnapshotRead = async ([filter]) => {
    if (!filter) throw new Error("no filter");
    filters.push(filter);
    if (!filter["#h"]?.includes(channel)) return [];
    const offset = filter.offset ?? 0;
    return revisions.slice(offset, offset + filter.limit);
  };
  return { read, filters };
}

async function loadAll(read: SnapshotRead, pages: number) {
  let history: History = emptyHistory;
  for (let page = 0; page < pages; page++)
    history = await loadOlder(read, channel, d, history);
  return history;
}

describe("history paging", () => {
  it("reads one d's history by offset pages and stops on a short page", async () => {
    const { read, filters } = relay(chain(HISTORY_PAGE + 5));
    const history = await loadAll(read, 3);
    expect(filters).toEqual([
      {
        kinds: [ARTIFACT_KIND],
        "#h": [channel],
        "#d": [d],
        artifact: "history",
        limit: HISTORY_PAGE,
        offset: 0,
      },
      {
        kinds: [ARTIFACT_KIND],
        "#h": [channel],
        "#d": [d],
        artifact: "history",
        limit: HISTORY_PAGE,
        offset: HISTORY_PAGE,
      },
    ]);
    expect(history.done).toBe(true);
    expect(history.revisions).toHaveLength(HISTORY_PAGE + 5);
    expect(segments(history)).toEqual([{ revisions: history.revisions }]);
  });

  it("drops repeats when a revision arrives between pages", async () => {
    const revisions = chain(HISTORY_PAGE + 2);
    const { read } = relay(revisions);
    let history = await loadOlder(read, channel, d, emptyHistory);
    revisions.unshift(rev("new", `r${HISTORY_PAGE + 1}`));
    history = await loadOlder(read, channel, d, history);
    const ids = history.revisions.map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(HISTORY_PAGE + 2);
    expect(segments(history)).toHaveLength(1);
  });
});

describe("history gaps", () => {
  it("labels a predecessor on an unread page unloaded", async () => {
    const { read } = relay(chain(HISTORY_PAGE + 1));
    const [segment] = segments(await loadAll(read, 1));
    expect(segment?.gap).toBe("unloaded");
  });

  it("labels the predecessor past the relay's offset ceiling capped", async () => {
    const { read, filters } = relay(chain(HISTORY_LIMIT + 1));
    const history = await loadAll(read, HISTORY_LIMIT / HISTORY_PAGE + 1);
    expect(filters).toHaveLength(HISTORY_LIMIT / HISTORY_PAGE);
    expect(filters.at(-1)?.offset).toBe(10_000);
    expect(history.revisions).toHaveLength(HISTORY_LIMIT);
    expect(segments(history).at(-1)?.gap).toBe("capped");
  });

  it("labels a failed page failed, keeps what loaded and retries the same offset", async () => {
    const revisions = chain(HISTORY_PAGE + 1);
    const ok = relay(revisions);
    let fail = false;
    const read: SnapshotRead = async (filters, options) => {
      if (fail) throw new Error("offline");
      return ok.read(filters, options);
    };
    let history = await loadOlder(read, channel, d, emptyHistory);
    fail = true;
    history = await loadOlder(read, channel, d, history);
    expect(history.revisions).toHaveLength(HISTORY_PAGE);
    expect(segments(history)[0]?.gap).toBe("failed");
    fail = false;
    history = await loadOlder(read, channel, d, history);
    expect(ok.filters.at(-1)?.offset).toBe(HISTORY_PAGE);
    expect(segments(history)).toEqual([{ revisions }]);
  });

  it("calls a missing predecessor unavailable only after every page loaded", async () => {
    // r1 was redacted: r2 names it, but history never returns it.
    const { read } = relay([rev("r2", "r1"), rev("r0")]);
    const history = await loadAll(read, 1);
    expect(history.done).toBe(true);
    expect(segments(history)).toEqual([
      { revisions: [history.revisions[0]], gap: "unavailable" },
      { revisions: [history.revisions[1]] },
    ]);
  });

  it("builds the disconnected older segment behind a gap, not just the current chain", async () => {
    const { read } = relay([
      rev("r4", "r3"),
      rev("r3", "r2"),
      rev("r1", "r0"),
      rev("r0"),
    ]);
    const ids = segments(await loadAll(read, 1)).map((s) => [
      s.revisions.map((event) => event.id),
      s.gap,
    ]);
    expect(ids).toEqual([
      [["r4", "r3"], "unavailable"],
      [["r1", "r0"], undefined],
    ]);
  });
});

describe("diff", () => {
  it("diffs instruction text by line", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { type: "same", text: "a" },
      { type: "added", text: "B" },
      { type: "removed", text: "b" },
      { type: "same", text: "c" },
      { type: "added", text: "d" },
    ]);
  });

  it("diffs settings by field", () => {
    const settings = (value: object) =>
      JSON.stringify({ version: 1, agentType: "claude-code", settings: value });
    expect(
      settingsDiff(
        settings({ model: "a", effort: "low" }),
        settings({ model: "b", scope: "x" }),
      ),
    ).toEqual([
      { field: "effort", before: "low", after: undefined },
      { field: "model", before: "a", after: "b" },
      { field: "scope", before: undefined, after: "x" },
    ]);
  });
});

describe("revert", () => {
  const expected = { channel, d, type: "buzz.agent.instructions" as const };

  it("publishes the old snapshot as op=update on the current head", () => {
    const old = rev("r0", undefined, {
      content: '{"version":1,"text":"old","extra":1}',
    });
    const head = rev("r1", "r0", { tags: [["client", "kept"]] });
    const template = revertTemplate(expected, head, old);
    expect(template.content).toBe(old.content);
    expect(template.tags).toEqual([
      ["ar", "1"],
      ["d", d],
      ["h", channel],
      ["type", "buzz.agent.instructions"],
      ["title", "Agent instructions"],
      ["op", "update"],
      ["prev", "r1"],
      ["client", "kept"],
    ]);
  });

  const teamExpected = { ...expected, type: "buzz.team" as const, team: "t1" };
  const team = (
    id: string,
    prev: string | undefined,
    name: string,
    instructions: string,
    title = name,
  ) =>
    rev(id, prev, {
      type: "buzz.team",
      title,
      content: JSON.stringify({ version: 1, name, instructions }),
      tags: [["team", "t1"]],
    });

  it("keeps a team's current name", () => {
    const old = team("r0", undefined, "Old", "before");
    const head = team("r1", "r0", "New", "after");
    expect(revisionProblem(teamExpected, old)).toBeUndefined();
    expect(revisionProblem(teamExpected, head)).toBeUndefined();
    const template = revertTemplate(teamExpected, head, old);
    expect(JSON.parse(template.content)).toEqual({
      version: 1,
      name: "New",
      instructions: "before",
    });
    expect(template.tags).toContainEqual(["title", "New"]);
    expect(template.tags).toContainEqual(["team", "t1"]);
    expect(template.tags).toContainEqual(["op", "update"]);
  });

  it("refuses to republish a malformed or unsupported revision", () => {
    const head = rev("r2", "r1");
    for (const content of ["not-json", '{"version":2,"text":"future"}'])
      expect(() =>
        revertTemplate(expected, head, rev("r0", undefined, { content })),
      ).toThrow(/isn't valid/);
  });

  it("repairs an invalid head from a valid older revision", () => {
    const old = rev("r0");
    const head = rev("r1", "r0", { content: "not-json" });
    const template = revertTemplate(expected, head, old);
    expect(template.content).toBe(old.content);
    expect(template.tags).toContainEqual(["prev", "r1"]);
    // A team head whose name no longer matches its title takes the target's.
    const brokenTeam = team("t2", "t1r", "New", "after", "Other");
    const template2 = revertTemplate(
      teamExpected,
      brokenTeam,
      team("t0", undefined, "Old", "before"),
    );
    expect(JSON.parse(template2.content)).toMatchObject({ name: "Old" });
    expect(template2.tags).toContainEqual(["title", "Old"]);
  });

  it("keeps the head's plugin notes when settings are reverted", () => {
    const settingsExpected = {
      ...expected,
      type: "buzz.agent.settings" as const,
    };
    const settings = (id: string, prev: string | undefined, body: object) =>
      rev(id, prev, {
        type: "buzz.agent.settings",
        title: "Agent settings",
        content: JSON.stringify({ version: 1, settings: {}, ...body }),
      });
    const check = { agentType: "goose", schema: {} } as const;
    const note = (tag: string) => ({ "org.example": { data: 1, tag } });
    const notesIn = (template: { content: string; tags: string[][] }) => ({
      notes: JSON.parse(template.content).pluginNotes,
      tags: template.tags.filter((tag) => tag[0] === "note"),
    });
    // The head's notes win over the target's...
    expect(
      notesIn(
        revertTemplate(
          settingsExpected,
          settings("r1", "r0", { pluginNotes: note("new") }),
          settings("r0", undefined, { pluginNotes: note("old") }),
          check,
        ),
      ),
    ).toEqual({
      notes: note("new"),
      tags: [["note", "org.example", "new"]],
    });
    // ...and are kept going back to a revision before any note...
    expect(
      notesIn(
        revertTemplate(
          settingsExpected,
          settings("r1", "r0", { pluginNotes: note("new") }),
          settings("r0", undefined, {}),
          check,
        ),
      ).notes,
    ).toEqual(note("new"));
    // ...and a head with none brings none back.
    expect(
      notesIn(
        revertTemplate(
          settingsExpected,
          settings("r1", "r0", {}),
          settings("r0", undefined, { pluginNotes: note("old") }),
          check,
        ),
      ),
    ).toEqual({ notes: undefined, tags: [] });
    // Restoring deleted settings keeps the notes they had.
    const deleted = rev("r2", "r1", {
      op: "delete",
      content: "",
      type: "buzz.agent.settings",
      title: "Agent settings",
    });
    expect(
      notesIn(
        revertTemplate(
          settingsExpected,
          deleted,
          settings("r1", "r0", { pluginNotes: note("old") }),
          check,
        ),
      ),
    ).toEqual({ notes: note("old"), tags: [["note", "org.example", "old"]] });
  });

  it("checks settings against the plugin schema before reverting", () => {
    const settingsExpected = {
      ...expected,
      type: "buzz.agent.settings" as const,
    };
    const check = { agentType: "goose", schema: { model: "string" } } as const;
    const settings = (id: string, prev: string | undefined, body: object) =>
      rev(id, prev, {
        type: "buzz.agent.settings",
        content: JSON.stringify({
          version: 1,
          agentType: "goose",
          settings: body,
        }),
      });
    const head = settings("r1", "r0", { model: "b" });
    const valid = settings("r0", undefined, { model: "a" });
    expect(revertTemplate(settingsExpected, head, valid, check).content).toBe(
      valid.content,
    );
    expect(() =>
      revertTemplate(
        settingsExpected,
        head,
        settings("r0", undefined, { retired: "x" }),
        check,
      ),
    ).toThrow(/Unknown setting/);
    expect(() => revertTemplate(settingsExpected, head, valid)).toThrow(
      /No settings schema/,
    );
  });

  it("restores over a deletion with op=restore, and never reverts to one", () => {
    const old = rev("r0", undefined, { tags: [["client", "old"]] });
    const deleted = rev("r1", "r0", {
      op: "delete",
      content: "",
      tags: [["client", "gone"]],
    });
    const template = revertTemplate(expected, deleted, old);
    expect(template.content).toBe(old.content);
    expect(template.tags).toContainEqual(["op", "restore"]);
    expect(template.tags).toContainEqual(["prev", "r1"]);
    expect(template.tags).toContainEqual(["client", "old"]);
    expect(template.tags).not.toContainEqual(["client", "gone"]);
    expect(() => revertTemplate(expected, rev("r2", "r1"), deleted)).toThrow();
  });
});

it("reuses loaded pages only for the same session, subject, head and history version", async () => {
  const head = rev("r1", "r0");
  const { read } = relay([head, rev("r0")]);
  const expected = { channel, d, type: "buzz.agent.instructions" } as const;
  const history = await loadOlder(read, channel, d, emptyHistory);
  rememberHistory(read, expected, head, 0, history);
  expect(recalledHistory(read, expected, head, 0)).toBe(history);
  expect(recalledHistory(read, expected, head, 1)).toBeUndefined();
  expect(recalledHistory(read, expected, rev("r2", "r1"), 0)).toBeUndefined();
  expect(
    recalledHistory(relay([head]).read, expected, head, 0),
  ).toBeUndefined();
  expect(
    recalledHistory(read, { ...expected, channel: "other" }, head, 0),
  ).toBeUndefined();
  rememberHistory(read, { ...expected, d: "second" }, head, 0, history);
  rememberHistory(read, { ...expected, d: "third" }, head, 0, history);
  expect(recalledHistory(read, expected, head, 0)).toBeUndefined();
  expect(recalledHistory(read, { ...expected, d: "second" }, head, 0)).toBe(
    history,
  );
});
