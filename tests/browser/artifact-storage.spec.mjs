import { fileURLToPath } from "node:url";
import { test as base, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";

const test = base.extend({
  storageUrl: [
    async ({ browserName }, use) => {
      if (!["chromium", "webkit"].includes(browserName))
        throw new Error("Unsupported storage test engine");
      const server = await createServer({
        root: fileURLToPath(new URL("../../", import.meta.url)),
        configFile: false,
        envDir: false,
        logLevel: "error",
        server: { host: "127.0.0.1", port: 0 },
      });
      await server.listen();
      try {
        await use(
          `${server.resolvedUrls.local[0]}tests/fixtures/artifact-storage.html`,
        );
      } finally {
        await server.close();
      }
    },
    { scope: "worker" },
  ],
});
async function open(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => !!window.artifactTest);
}

// Real IndexedDB completion, restart and BroadcastChannel cannot be proved in a DOM emulator.
test("commits across windows and survives offline restart with isolated scopes", async ({
  page,
  context,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const other = await context.newPage();
  await open(other, storageUrl);
  await other.evaluate(async () => {
    window.collection = window.artifactTest.open();
    await window.collection.get("task");
    window.change = new Promise((resolve) => {
      window.collection.subscribe(async () =>
        resolve(await window.collection.get("task")),
      );
    });
  });
  await page.evaluate(async () => {
    const collection = window.artifactTest.open();
    await collection.importBatch({
      records: [{ id: "task", local: { title: "saved" } }],
      preferences: [{ id: "task", value: { pinned: false } }],
      marker: "done",
    });
  });
  expect((await other.evaluate(() => window.change)).preference).toEqual({
    pinned: false,
  });
  await other.evaluate(() => {
    window.errorChange = new Promise((resolve) => {
      const stop = window.collection.subscribe(async () => {
        const error = await window.collection.refreshError();
        if (error) {
          stop();
          resolve(error);
        }
      });
    });
  });
  await page.evaluate(async () => {
    const c = window.artifactTest.open();
    const refresh = await c.beginRefresh("all");
    await c.setRefreshError(refresh, "Refresh unavailable");
  });
  expect(await other.evaluate(() => window.errorChange)).toBe(
    "Refresh unavailable",
  );
  await page.reload();
  await page.waitForFunction(() => !!window.artifactTest);
  await context.setOffline(true);
  const result = await page.evaluate(async () => {
    const collection = window.artifactTest.open();
    return {
      row: await collection.get("task"),
      marker: await collection.imported("done"),
      refreshError: await collection.refreshError(),
      identities: await window.artifactTest.open("other").get("task"),
      relays: await window.artifactTest.open("viewer", "other").get("task"),
      plugins: await window.artifactTest
        .open("viewer", "relay", "other")
        .get("task"),
      collections: await window.artifactTest
        .open("viewer", "relay", "test", { name: "other" })
        .get("task"),
    };
  });
  expect(result.row.record.local).toEqual({ title: "saved" });
  expect(result.marker).toBe(true);
  expect(result.refreshError).toBe("Refresh unavailable");
  for (const field of ["identities", "relays", "plugins", "collections"])
    expect(result[field]).toBeUndefined();
});

test("notifies another window when a committed writer closes", async ({
  page,
  context,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const other = await context.newPage();
  await open(other, storageUrl);
  await other.evaluate(async () => {
    const c = window.artifactTest.open();
    await c.get("saved");
    window.committedValue = null;
    c.subscribe(async () => {
      window.committedValue = (await c.get("saved"))?.record.local;
    });
  });
  const closed = await page.evaluate(async () => {
    const c = window.artifactTest.open();
    await c.get("saved");
    const transaction = IDBDatabase.prototype.transaction;
    let closed = false;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = transaction.apply(this, args);
      IDBDatabase.prototype.transaction = transaction;
      tx.addEventListener(
        "complete",
        () => {
          c.close();
          closed = true;
        },
        { once: true },
      );
      return tx;
    };
    try {
      await c.importBatch({
        records: [{ id: "saved", local: { title: "saved" } }],
      });
      return closed;
    } finally {
      IDBDatabase.prototype.transaction = transaction;
    }
  });
  expect(closed).toBe(true);
  await expect
    .poll(() => other.evaluate(() => window.committedValue))
    .toEqual({ title: "saved" });
});

test("continues indexed pages and raw ID pages through their final cursors", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    const c = window.artifactTest.open("viewer", "relay", "test", {
      project: () => [{ index: "all", value: "", order: "same" }],
    });
    await c.importBatch({
      records: ["a", "b", "c"].map((id) => ({ id, local: {} })),
    });
    const first = await c.page({ index: "all", value: "", limit: 2 });
    const last = await c.page({
      index: "all",
      value: "",
      limit: 2,
      after: first.next,
    });
    const empty = await c.page({
      index: "all",
      value: "",
      after: { order: "same", id: "c" },
    });
    const ids = await c.knownIds({ limit: 2 });
    const lastIds = await c.knownIds({ limit: 2, after: ids.next });
    const emptyIds = await c.knownIds({ after: "c" });
    return {
      first: {
        ids: first.entries.map((entry) => entry.record.id),
        next: first.next,
      },
      last: {
        ids: last.entries.map((entry) => entry.record.id),
        next: last.next,
      },
      empty,
      ids,
      lastIds,
      emptyIds,
    };
  });
  expect(result).toEqual({
    first: { ids: ["a", "b"], next: { order: "same", id: "b" } },
    last: { ids: ["c"], next: undefined },
    empty: { entries: [] },
    ids: { ids: ["a", "b"], next: "b" },
    lastIds: { ids: ["c"] },
    emptyIds: { ids: [] },
  });
});

test("rolls back received batches and migration failures without publishing changes", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    const c = window.artifactTest.open();
    const notices = [];
    c.subscribe(() => notices.push("change"));
    const records = [
      {
        id: "good",
        channelId: "channel",
        type: "test.task",
        revision: { id: "a", content: "{}" },
      },
      {
        id: "bad",
        channelId: "",
        type: "test.task",
        revision: { id: "bad", content: "{}" },
      },
    ];
    const failure = await c
      .applyBatch({
        source: "all",
        refresh: await c.beginRefresh("all"),
        records,
      })
      .then(
        () => "unexpected",
        (error) => error.message,
      );
    const after = await c.get("good");
    const checkpoint = await c.checkpoint();
    const failedImport = window.artifactTest.open("viewer", "relay", "test", {
      name: "failed-import",
      project: () => {
        throw new Error("import projection failed");
      },
    });
    const importFailure = await failedImport
      .importBatch({
        records: [{ id: "one", local: {} }],
        preferences: [{ id: "one", value: false }],
        marker: "done",
      })
      .then(
        () => "unexpected",
        (error) => error.message,
      );
    const original = window.artifactTest.open("viewer", "relay", "test", {
      name: "migration",
    });
    await original.importBatch({
      records: [{ id: "one", local: { title: "saved" } }],
      preferences: [{ id: "one", value: false }],
      marker: "done",
    });
    const refresh = await original.beginRefresh("all");
    await original.completeRefresh(refresh, { expected: null, next: "saved" });
    const failing = window.artifactTest.open("viewer", "relay", "test", {
      name: "migration",
      version: 2,
      project: () => {
        throw new Error("projection failed");
      },
    });
    const migration = await failing.get("one").then(
      () => "unexpected",
      (error) => error.message,
    );
    return {
      failure,
      after,
      checkpoint,
      notices,
      migration,
      importFailure,
      failedImport: {
        row: await failedImport.get("one"),
        marker: await failedImport.imported("done"),
        preference: await failedImport.preferences.get("one"),
      },
      imported: await original.imported("done"),
      pref: await original.preferences.get("one"),
      saved: (await original.get("one")).record.local,
      progress: await original.checkpoint(),
      indexed: (
        await original.page({ index: "archive", value: "false" })
      ).entries.map((entry) => entry.record.id),
    };
  });
  expect(result).toEqual({
    failure: "Invalid authoritative artifact",
    after: undefined,
    checkpoint: null,
    notices: [],
    migration: "projection failed",
    importFailure: "import projection failed",
    failedImport: { row: undefined, marker: false, preference: undefined },
    imported: true,
    pref: false,
    saved: { title: "saved" },
    progress: "saved",
    indexed: ["one"],
  });
});

test("atomically indexes preference changes and preserves newer values during migration retries", async ({
  page,
  context,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const other = await context.newPage();
  await open(other, storageUrl);
  await page.evaluate(async () => {
    window.collection = window.artifactTest.open();
    await window.collection.importBatch({
      records: [{ id: "task", local: { archived: false } }],
      preferences: [{ id: "task", value: { pinned: true } }],
    });
  });
  await other.evaluate(async () => {
    const c = window.artifactTest.open();
    await c.preferences.update("task", () => ({
      archived: true,
      pinned: false,
    }));
  });
  const result = await page.evaluate(async () => {
    const c = window.collection;
    await c.importBatch({
      records: [{ id: "task", local: { lost: true } }],
      preferences: [{ id: "task", value: { pinned: true } }],
      marker: "done",
    });
    const arrivalOrders = [];
    for (const order of ["sync-first", "import-first"]) {
      const ordered = window.artifactTest.open("viewer", "relay", "test", {
        name: order,
      });
      const seed = () =>
        ordered.importBatch({
          records: [{ id: "task", local: { title: "saved device snapshot" } }],
          preferences: [{ id: "task", value: false }],
          marker: "done",
        });
      const sync = async () =>
        ordered.applyBatch({
          source: "all",
          refresh: await ordered.beginRefresh("all"),
          records: [
            {
              id: "task",
              channelId: "channel",
              type: "test.task",
              revision: { id: "shared", content: "{}" },
            },
          ],
        });
      if (order === "sync-first") {
        await sync();
        await seed();
      } else {
        await seed();
        await sync();
      }
      await ordered.importBatch({
        records: [{ id: "task", local: { title: "discarded retry" } }],
        preferences: [{ id: "task", value: true }],
        marker: "retry",
      });
      const entry = await ordered.get("task");
      arrivalOrders.push({
        local: entry.record.local,
        current: entry.record.current,
        preference: entry.preference,
        imported: await ordered.imported("done"),
        retried: await ordered.imported("retry"),
      });
    }
    return {
      arrivalOrders,
      archived: await c.page({ index: "archive", value: "true" }),
      active: await c.page({ index: "archive", value: "false" }),
      row: await c.get("task"),
    };
  });
  expect(result.active.entries).toHaveLength(0);
  expect(result.archived.entries).toHaveLength(1);
  expect(result.row.preference).toEqual({ archived: true, pinned: false });
  expect(result.row.record.local).toEqual({ archived: false });
  expect(result.arrivalOrders).toEqual([
    {
      local: { title: "saved device snapshot" },
      current: { id: "shared", content: "{}" },
      preference: false,
      imported: true,
      retried: true,
    },
    {
      local: { title: "saved device snapshot" },
      current: { id: "shared", content: "{}" },
      preference: false,
      imported: true,
      retried: true,
    },
  ]);
});

test("reuses unchanged stored state and indexes after repeat delivery", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    let projections = 0;
    const c = window.artifactTest.open("viewer", "relay", "test", {
      project: ({ record, preference }) => {
        projections++;
        return [
          {
            index: "state",
            value: JSON.stringify([
              record.local,
              preference,
              record.availability,
            ]),
            order: record.id,
          },
        ];
      },
    });
    const record = {
      id: "task",
      channelId: "channel",
      type: "test.task",
      revision: { id: "A", content: "{}" },
    };
    const refresh = await c.beginRefresh("all");
    const batch = {
      source: "all",
      refresh,
      records: [record],
      availability: [
        {
          id: "task",
          expectedRevision: "A",
          value: { state: "available" },
        },
      ],
    };
    await c.applyBatch(batch);
    await c.importBatch({
      records: [
        { id: "task", local: { title: "device", labels: ["one", "two"] } },
      ],
      preferences: [{ id: "task", value: { pinned: false, rank: 0 } }],
    });
    const before = await c.get("task");
    projections = 0;
    const writes = [];
    const put = IDBObjectStore.prototype.put;
    const remove = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.put = function (...args) {
      if (["records", "preferences", "entries"].includes(this.name))
        writes.push(this.name);
      return put.apply(this, args);
    };
    IDBObjectStore.prototype.delete = function (...args) {
      if (this.name === "entries") writes.push(this.name);
      return remove.apply(this, args);
    };
    try {
      await c.applyBatch(structuredClone(batch));
      await c.preferences.update("task", () => ({ rank: 0, pinned: false }));
      await c.importBatch({
        records: [{ id: "task", local: { title: "discarded retry" } }],
        preferences: [{ id: "task", value: true }],
        marker: "retry",
      });
      return {
        writes,
        projections,
        before,
        after: await c.get("task"),
        indexed: await c.page({
          index: "state",
          value: JSON.stringify([
            { title: "device", labels: ["one", "two"] },
            { pinned: false, rank: 0 },
            { state: "available" },
          ]),
        }),
        imported: await c.imported("retry"),
      };
    } finally {
      IDBObjectStore.prototype.put = put;
      IDBObjectStore.prototype.delete = remove;
    }
  });
  expect(result.writes).toEqual([]);
  expect(result.projections).toBe(0);
  expect(result.after).toEqual(result.before);
  expect(result.indexed.entries).toEqual([result.before]);
  expect(result.imported).toBe(true);
});

test("commits changed local data, preferences, revisions and availability", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    const c = window.artifactTest.open("viewer", "relay", "test", {
      project: ({ record, preference }) => [
        {
          index: "state",
          value: JSON.stringify([
            record.local,
            preference,
            record.channelId,
            record.current,
            record.availability,
          ]),
          order: record.id,
        },
      ],
    });
    const refresh = await c.beginRefresh("all");
    const record = {
      id: "task",
      channelId: "channel",
      type: "test.task",
      revision: { id: "A", content: "{}" },
    };
    const states = [];
    async function capture() {
      const entry = await c.get("task");
      const r = entry.record;
      const page = await c.page({
        index: "state",
        value: JSON.stringify([
          r.local,
          entry.preference,
          r.channelId,
          r.current,
          r.availability,
        ]),
      });
      states.push({ entry, indexed: page.entries });
    }
    await c.applyBatch({ source: "all", refresh, records: [record] });
    await c.importBatch({
      records: [{ id: "task", local: { title: "device" } }],
    });
    await capture();
    await c.preferences.update("task", () => ({ pinned: false }));
    await c.preferences.update("task", (current) => {
      current.pinned = true;
      return current;
    });
    await capture();
    for (const revision of [
      { id: "A", content: '{"title":"updated"}' },
      {
        id: "A",
        content: '{"title":"updated"}',
        event: { tags: [["x", "one"]] },
      },
      {
        id: "A",
        content: '{"title":"updated"}',
        event: { tags: [["x", "two"]] },
      },
    ]) {
      await c.applyBatch({
        source: "all",
        refresh,
        records: [{ ...record, revision }],
      });
      await capture();
    }
    await c.applyBatch({
      source: "all",
      refresh,
      records: [{ ...record, channelId: "moved" }],
    });
    await capture();
    for (const value of [
      { state: "unavailable", reason: "access" },
      { state: "unavailable", reason: "removed" },
      { state: "available" },
    ]) {
      await c.applyBatch({
        source: "all",
        refresh,
        availability: [{ id: "task", expectedRevision: "A", value }],
      });
      await capture();
    }
    return states;
  });
  for (const { entry, indexed } of result) expect(indexed).toEqual([entry]);
  expect(result[0].entry.record.local).toEqual({ title: "device" });
  expect(result[1].entry.preference).toEqual({ pinned: true });
  expect(result.slice(2, 5).map(({ entry }) => entry.record.current)).toEqual([
    { id: "A", content: '{"title":"updated"}' },
    {
      id: "A",
      content: '{"title":"updated"}',
      event: { tags: [["x", "one"]] },
    },
    {
      id: "A",
      content: '{"title":"updated"}',
      event: { tags: [["x", "two"]] },
    },
  ]);
  expect(result[5].entry.record.channelId).toBe("moved");
  expect(result.slice(6).map(({ entry }) => entry.record.availability)).toEqual(
    [
      { state: "unavailable", reason: "access" },
      { state: "unavailable", reason: "removed" },
      { state: "available" },
    ],
  );
});

test("commits delta progress without inferring absence and preserves device data", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    const c = window.artifactTest.open();
    const record = (id) => ({
      id,
      channelId: "channel",
      type: "test.task",
      revision: { id, content: "{}" },
    });
    const seed = await c.beginRefresh("all");
    await c.applyBatch({
      source: "all",
      refresh: seed,
      records: [record("missing"), record("seen")],
      availability: ["missing", "seen"].map((id) => ({
        id,
        expectedRevision: id,
        value: { state: "available" },
      })),
    });
    await c.completeRefresh(seed, { expected: null, next: "seed" });
    await c.preferences.update("missing", () => ({ pinned: false }));
    await c.importBatch({
      records: [{ id: "device-only", local: { title: "saved" } }],
    });
    const partial = await c.beginRefresh("all");
    await c.applyBatch({
      source: "all",
      refresh: partial,
    });
    await c.setRefreshError(partial, "Refresh limit reached");
    const before = await c.get("missing");
    const error = await c.refreshError();
    const refresh = await c.beginRefresh("all");
    const retainedError = await c.refreshError();
    const stale = await c
      .completeRefresh(partial, { expected: "seed", next: "wrong" })
      .then(
        () => "unexpected",
        (e) => e.message,
      );
    const wrongQuery = await c.beginRefresh("other").then(
      () => "unexpected",
      (e) => e.message,
    );
    await c.applyBatch({
      source: "all",
      refresh,
    });
    await c.completeRefresh(refresh, { expected: "seed", next: "complete" });
    const lateError = await c.setRefreshError(partial, "old error").then(
      () => "unexpected",
      (e) => e.message,
    );
    return {
      before,
      error,
      retainedError,
      stale,
      wrongQuery,
      lateError,
      missing: await c.get("missing"),
      seen: await c.get("seen"),
      local: await c.get("device-only"),
      checkpoint: await c.checkpoint(),
      clearedError: await c.refreshError(),
    };
  });
  expect(result.before.record.availability.state).toBe("available");
  expect(result.error).toBe("Refresh limit reached");
  expect(result.retainedError).toBe(result.error);
  expect(result.stale).toBe("Artifact refresh changed");
  expect(result.wrongQuery).toBe("Artifact collection query changed");
  expect(result.lateError).toBe("Artifact refresh changed");
  expect(result.missing.record.availability.state).toBe("available");
  expect(result.missing.record.current.content).toBe("{}");
  expect(result.missing.preference).toEqual({ pinned: false });
  expect(result.seen.record.availability.state).toBe("available");
  expect(result.local.record.local).toEqual({ title: "saved" });
  expect(result.checkpoint).toBe("complete");
  expect(result.clearedError).toBeNull();
});

test("applies explicit removals after missed revisions and rejects a failed page", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    const c = window.artifactTest.open();
    const record = (id, revision) => ({
      id,
      channelId: "channel",
      type: "test.task",
      revision: { id: revision, content: "{}" },
    });
    const initial = await c.beginRefresh("all");
    await c.applyBatch({
      source: "all",
      refresh: initial,
      records: [record("task", "local-A")],
      availability: [
        {
          id: "task",
          expectedRevision: "local-A",
          value: { state: "available" },
        },
      ],
    });
    await c.completeRefresh(initial, { expected: null, next: "initial" });
    await c.preferences.update("task", () => false);
    const refresh = await c.beginRefresh("all");
    const failure = await c
      .applyBatch({
        source: "all",
        refresh,
        records: [record("new", "new-rev")],
        availability: [
          {
            id: "task",
            expectedRevision: "relay-B-not-saved",
            value: { state: "unavailable" },
          },
        ],
      })
      .then(
        () => "unexpected",
        (e) => e.message,
      );
    const progressAfterFailure = await c.checkpoint();
    const newAfterFailure = await c.get("new");
    const before = await c.get("task");
    await c.applyBatch({
      source: "all",
      refresh,
      availability: [
        {
          id: "task",
          expectedRevision: before.record.current.id,
          value: { state: "unavailable" },
        },
      ],
    });
    const mismatch = await c
      .completeRefresh(refresh, { expected: "wrong", next: "bad" })
      .then(
        () => "unexpected",
        (e) => e.message,
      );
    await c.completeRefresh(refresh, { expected: "initial", next: "removed" });
    const removed = await c.get("task");
    const restored = await c.beginRefresh("all");
    await c.applyBatch({
      source: "all",
      refresh: restored,
      records: [record("task", "relay-C")],
      availability: [
        {
          id: "task",
          expectedRevision: "relay-C",
          value: { state: "available" },
        },
      ],
    });
    await c.completeRefresh(restored, {
      expected: "removed",
      next: "restored",
    });
    return {
      failure,
      progressAfterFailure,
      newAfterFailure,
      mismatch,
      removed,
      restored: await c.get("task"),
    };
  });
  expect(result.failure).toBe("Artifact revision changed");
  expect(result.progressAfterFailure).toBe("initial");
  expect(result.newAfterFailure).toBeUndefined();
  expect(result.mismatch).toBe("Artifact checkpoint changed");
  expect(result.removed.record.current.id).toBe("local-A");
  expect(result.removed.record.availability.state).toBe("unavailable");
  expect(result.removed.preference).toBe(false);
  expect(result.restored.record.current.id).toBe("relay-C");
  expect(result.restored.record.availability.state).toBe("available");
  expect(result.restored.preference).toBe(false);
});

test("reads bounded indexed pages for 10,000 tasks and 40,000 archived records @local-only", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    const c = window.artifactTest.open();
    const start = performance.now();
    for (let offset = 0; offset < 50000; offset += 1000) {
      await c.importBatch({
        records: Array.from({ length: 1000 }, (_, n) => ({
          id: String(offset + n).padStart(6, "0"),
          local: { archived: offset + n >= 10000 },
        })),
      });
    }
    const savedMs = performance.now() - start;
    let scans = 0;
    const cursor = IDBObjectStore.prototype.openCursor;
    IDBObjectStore.prototype.openCursor = function (...args) {
      if (this.name === "records") scans++;
      return cursor.apply(this, args);
    };
    try {
      const refresh = await c.beginRefresh("all");
      await c.completeRefresh(refresh, { expected: null, next: "complete" });
    } finally {
      IDBObjectStore.prototype.openCursor = cursor;
    }
    const ids = await c.knownIds({ limit: 75 });
    const nextIds = await c.knownIds({ limit: 75, after: ids.next });
    let reads = 0;
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (...args) {
      if (this.name === "records") reads++;
      return get.apply(this, args);
    };
    const begin = performance.now();
    const first = await c.page({ index: "archive", value: "false", limit: 75 });
    const second = await c.page({
      index: "archive",
      value: "false",
      limit: 75,
      after: first.next,
    });
    const archive = await c.page({
      index: "archive",
      value: "true",
      limit: 75,
    });
    const elapsedMs = performance.now() - begin;
    IDBObjectStore.prototype.get = get;
    const idleWrites = [];
    for (let n = 0; n < 20; n++) {
      const start = performance.now();
      await c.preferences.update("000000", () => ({ pinned: n % 2 === 0 }));
      idleWrites.push(performance.now() - start);
    }
    const contendedWrites = [];
    const refresh = await c.beginRefresh("all");
    for (const batchSize of [100, 1000]) {
      for (let n = 0; n < 5; n++) {
        let started;
        const active = new Promise((resolve) => {
          started = resolve;
        });
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
          const request = put.apply(this, args);
          if (this.name === "records") {
            IDBObjectStore.prototype.put = put;
            started();
          }
          return request;
        };
        const backgroundStart = performance.now();
        const background = c.applyBatch({
          source: "all",
          refresh,
          records: Array.from({ length: batchSize }, (_, i) => ({
            id: String(10000 + i).padStart(6, "0"),
            channelId: "channel",
            type: "test.task",
            revision: {
              id: `rev-${batchSize}-${n}-${i}`,
              content: JSON.stringify({
                archived: true,
                title: "x".repeat(500),
              }),
            },
          })),
        });
        try {
          await active;
          const start = performance.now();
          await c.preferences.update("000000", () => ({ pinned: true }));
          const writeMs = performance.now() - start;
          await background;
          contendedWrites.push({
            batchSize,
            writeMs,
            batchMs: performance.now() - backgroundStart,
          });
        } finally {
          IDBObjectStore.prototype.put = put;
        }
      }
    }
    const preference = await c.preferences.get("000000");
    window.artifactTest.close();
    const reopened = window.artifactTest.open();
    return {
      savedMs,
      idleWrites,
      contendedWrites,
      preference,
      elapsedMs,
      scans,
      ids,
      nextIds,
      reads,
      first: first.entries.map((e) => e.record.id),
      second: second.entries.map((e) => e.record.id),
      archive: archive.entries.map((e) => e.record.id),
      last: (await reopened.get("049999")).record.local,
    };
  });
  expect(result.preference).toEqual({ pinned: true });
  expect(result.scans).toBe(0);
  expect(result.ids.ids).toHaveLength(75);
  expect(result.nextIds.ids[0]).toBe("000075");
  expect(result.first).toHaveLength(75);
  expect(result.second[0]).toBe("000075");
  expect(result.archive[0]).toBe("010000");
  expect(result.reads).toBe(225);
  expect(result.last).toEqual({ archived: true });
  console.log(
    JSON.stringify({
      engine: test.info().project.name,
      savedMs: result.savedMs,
      pageMs: result.elapsedMs,
      recordReads: result.reads,
      idleWrites: result.idleWrites,
      contendedWrites: result.contendedWrites,
    }),
  );
});

test("accepts authoritative heads without ancestry and rejects retired captures", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    const c = window.artifactTest.open();
    const record = (id, channelId) => ({
      id: "task",
      channelId,
      type: "test.task",
      revision: { id, content: "{}" },
    });
    const old = await c.beginRefresh("all");
    await c.applyBatch({
      source: "all",
      refresh: old,
      records: [record("A", "old-home")],
    });
    const newer = await c.beginRefresh("all");
    await c.applyBatch({
      source: "all",
      refresh: newer,
      records: [record("C", "new-home")],
      availability: [
        { id: "task", expectedRevision: "C", value: { state: "available" } },
      ],
    });
    const stale = await c
      .applyBatch({
        source: "all",
        refresh: old,
        records: [record("C", "new-home")],
      })
      .then(
        () => "unexpected",
        (e) => e.message,
      );
    const revision = await c
      .applyBatch({
        source: "all",
        refresh: newer,
        availability: [
          { id: "task", expectedRevision: "A", value: { state: "available" } },
        ],
      })
      .then(
        () => "unexpected",
        (e) => e.message,
      );
    const mismatch = await c
      .applyBatch({ source: "other", refresh: newer })
      .then(
        () => "unexpected",
        (e) => e.message,
      );
    const raw = await c
      .applyBatch({ source: "all", records: [record("raw-live", "bad-home")] })
      .then(
        () => "unexpected",
        (e) => e.message,
      );
    await c.completeRefresh(newer, { expected: null, next: "done" });
    return {
      stale,
      revision,
      mismatch,
      raw,
      row: await c.get("task"),
    };
  });
  expect(result.stale).toBe("Artifact refresh changed");
  expect(result.revision).toBe("Artifact revision changed");
  expect(result.mismatch).toBe("Artifact refresh source mismatch");
  expect(result.raw).toBe("Artifact refresh source mismatch");
  expect(result.row.record.current.id).toBe("C");
  expect(result.row.record.channelId).toBe("new-home");
  expect(result.row.record.availability.state).toBe("available");
  expect(result.row.record).not.toHaveProperty("unresolved");
  expect(result.row.record).not.toHaveProperty("conflicts");
});

test("aborts page and progress commits when the owner closes", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    const c = window.artifactTest.open();
    const refresh = await c.beginRefresh("all");
    await c.applyBatch({
      source: "all",
      refresh,
      records: [
        {
          id: "task",
          channelId: "channel",
          type: "test.task",
          revision: { id: "A", content: "{}" },
        },
      ],
      availability: [
        { id: "task", expectedRevision: "A", value: { state: "available" } },
      ],
    });
    const pre = new AbortController();
    pre.abort(new Error("owner closed"));
    const before = await c
      .completeRefresh(refresh, { expected: null, next: "bad" }, pre.signal)
      .then(
        () => "unexpected",
        (e) => e.message,
      );
    const put = IDBObjectStore.prototype.put;
    let controller;
    let abortCheckpoint = false;
    let abortRecord = false;
    let closeCheckpoint = false;
    IDBObjectStore.prototype.put = function (value, ...args) {
      const request = put.call(this, value, ...args);
      if (
        (this.name === "metadata" &&
          value.key === "checkpoint" &&
          abortCheckpoint) ||
        (this.name === "records" && abortRecord)
      )
        controller.abort(new Error("owner retired"));
      if (
        this.name === "metadata" &&
        value.key === "checkpoint" &&
        closeCheckpoint
      )
        c.close();
      return request;
    };
    try {
      controller = new AbortController();
      abortCheckpoint = true;
      const during = await c
        .completeRefresh(
          refresh,
          { expected: null, next: "bad" },
          controller.signal,
        )
        .then(
          () => "unexpected",
          (e) => e.message,
        );
      abortCheckpoint = false;
      abortRecord = true;
      controller = new AbortController();
      const batch = await c
        .applyBatch(
          {
            source: "all",
            refresh,
            records: [
              {
                id: "task",
                channelId: "new-home",
                type: "test.task",
                revision: { id: "B", content: "{}" },
              },
            ],
          },
          controller.signal,
        )
        .then(
          () => "unexpected",
          (e) => e.message,
        );
      abortRecord = false;
      const row = await c.get("task");
      const checkpoint = await c.checkpoint();
      closeCheckpoint = true;
      const closed = await c
        .completeRefresh(refresh, { expected: null, next: "closed" })
        .then(
          () => "unexpected",
          (e) => e.message,
        );
      return { before, during, batch, closed, row, checkpoint };
    } finally {
      IDBObjectStore.prototype.put = put;
    }
  });
  expect(result.before).toBe("owner closed");
  expect(result.during).toBe("owner retired");
  expect(result.batch).toBe("owner retired");
  expect(result.closed).toBe("Artifact collection closed");
  expect(result.row.record.current.id).toBe("A");
  expect(result.row.record.availability.state).toBe("available");
  expect(result.checkpoint).toBeNull();
});

test("upgrades across windows and rejects stale writes and refresh completion", async ({
  page,
  context,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const other = await context.newPage();
  await open(other, storageUrl);
  const refresh = await other.evaluate(async () => {
    window.collection = window.artifactTest.open();
    await window.collection.importBatch({
      records: [{ id: "task", local: {} }],
      preferences: [{ id: "task", value: true }],
    });
    return window.collection.beginRefresh("all");
  });
  const result = await page.evaluate(async () => {
    const newer = window.artifactTest.open("viewer", "relay", "test", {
      version: 2,
      project: ({ preference }) => [
        { index: "value", value: JSON.stringify(preference), order: "" },
      ],
    });
    window.collection = newer;
    await newer.preferences.update("task", () => null);
    const page = await newer.page({ index: "value", value: "null" });
    const older = window.artifactTest.open();
    const downgrade = await older.get("task").then(
      () => "unexpected",
      (e) => e.message,
    );
    const incompatible = window.artifactTest.open("viewer", "relay", "test", {
      version: 2,
      type: "other.task",
    });
    const type = await incompatible.get("task").then(
      () => "unexpected",
      (e) => e.message,
    );
    return { page, downgrade, type };
  });
  const stale = await other.evaluate(async (refresh) => {
    const error = (e) => e.message;
    return Promise.all([
      window.collection.preferences
        .update("task", () => false)
        .then(() => "unexpected", error),
      window.collection
        .completeRefresh(refresh, { expected: null, next: "stale" })
        .then(() => "unexpected", error),
    ]);
  }, refresh);
  expect(result.page.entries[0].preference).toBeNull();
  expect(stale).toEqual([
    "Artifact collection version changed",
    "Artifact collection version changed",
  ]);
  expect(result.downgrade).toBe("Artifact collection requires a newer plugin");
  expect(result.type).toBe("Artifact collection type changed");
  expect(
    await page.evaluate(async () => {
      const c = window.collection;
      return {
        preference: await c.preferences.get("task"),
        checkpoint: await c.checkpoint(),
      };
    }),
  ).toEqual({ preference: null, checkpoint: null });
});

test("purges one identity and relay across collections", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    const { createArtifactStore, purgeArtifactStorage } = await import(
      "/src/features/artifact-storage/store.ts"
    );
    const definition = {
      name: "one",
      type: "test.task",
      version: 1,
      project: () => [],
    };
    const first = createArtifactStore("viewer", "relay");
    const other = createArtifactStore("other", "relay");
    for (const c of [
      first.collection("test", definition),
      first.collection("test", { ...definition, name: "two" }),
      other.collection("test", definition),
    ]) {
      await c.importBatch({
        records: [{ id: "task", local: {} }],
        preferences: [{ id: "task", value: false }],
        marker: "done",
      });
    }
    first.close();
    other.close();
    const observer = createArtifactStore("viewer", "relay");
    const observed = observer.collection("test", definition);
    await observed.get("task");
    const notification = new Promise((resolve) => observed.subscribe(resolve));
    await purgeArtifactStorage("viewer", "relay");
    await notification;
    observer.close();
    const reopened = createArtifactStore("viewer", "relay");
    const a = reopened.collection("test", definition);
    const b = reopened.collection("test", { ...definition, name: "two" });
    const retained = createArtifactStore("other", "relay");
    const values = {
      one: await a.get("task"),
      two: await b.get("task"),
      pref: await a.preferences.get("task"),
      marker: await a.imported("done"),
      other: await retained.collection("test", definition).get("task"),
    };
    reopened.close();
    retained.close();
    return values;
  });
  expect(result.one).toBeUndefined();
  expect(result.two).toBeUndefined();
  expect(result.pref).toBeUndefined();
  expect(result.marker).toBe(false);
  expect(result.other.preference).toBe(false);
});

test("upgrades saved device data and removes the obsolete membership store", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("buzz-artifacts-v1", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of [
          "records",
          "preferences",
          "entries",
          "metadata",
          "members",
        ]) {
          const store = db.createObjectStore(name, {
            keyPath:
              name === "entries"
                ? ["scope", "collection", "index", "value", "order", "id"]
                : name === "members"
                  ? ["scope", "collection", "source", "id"]
                  : name === "metadata"
                    ? ["scope", "collection", "key"]
                    : ["scope", "collection", "id"],
          });
          if (name === "entries" || name === "members")
            store.createIndex("record", ["scope", "collection", "id"]);
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(["records", "preferences"], "readwrite");
        const prefix = {
          scope: "relay:viewer",
          collection: JSON.stringify(["test", "tasks"]),
          id: "task",
        };
        tx.objectStore("records").put({
          ...prefix,
          record: {
            id: "task",
            local: { title: "saved" },
            current: { id: "A", content: "{}" },
            channelId: "channel",
            type: "test.task",
            availability: { state: "unknown" },
          },
        });
        tx.objectStore("preferences").put({
          ...prefix,
          value: { pinned: false },
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => reject(tx.error);
      };
    });
    const c = window.artifactTest.open();
    const saved = await c.get("task");
    const page = await c.page({ index: "pin", value: "false" });
    const schema = await new Promise((resolve, reject) => {
      const request = indexedDB.open("buzz-artifacts-v1");
      request.onsuccess = () => {
        const db = request.result;
        resolve({
          version: db.version,
          members: db.objectStoreNames.contains("members"),
        });
        db.close();
      };
      request.onerror = () => reject(request.error);
    });
    return {
      saved,
      rows: page.entries.length,
      schema,
      channel: await c.knownIds({ channelId: "channel" }),
    };
  });
  expect(result.saved.record.local).toEqual({ title: "saved" });
  expect(result.saved.preference).toEqual({ pinned: false });
  expect(result.rows).toBe(1);
  expect(result.channel.ids).toEqual(["task"]);
  expect(result.schema).toEqual({ version: 3, members: false });
});

test("pages raw known IDs by channel without plugin index assumptions", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    const c = window.artifactTest.open("viewer", "relay", "test", {
      project: () => [],
    });
    const record = (id, channelId, revision = id) => ({
      id,
      channelId,
      type: "test.task",
      revision: { id: revision, content: "{}" },
    });
    const refresh = await c.beginRefresh("all");
    await c.applyBatch({
      source: "all",
      refresh,
      records: [record("a", "one"), record("b", "one"), record("c", "two")],
    });
    await c.importBatch({ records: [{ id: "local", local: {} }] });
    const first = await c.knownIds({ channelId: "one", limit: 1 });
    const second = await c.knownIds({
      channelId: "one",
      limit: 1,
      after: first.next,
    });
    await c.applyBatch({
      source: "all",
      refresh,
      records: [record("a", "two", "moved")],
    });
    return {
      first,
      second,
      all: await c.knownIds({}),
      one: await c.knownIds({ channelId: "one" }),
      two: await c.knownIds({ channelId: "two" }),
      projected: await c.page({ index: "none", value: "" }),
    };
  });
  expect(result.first).toEqual({ ids: ["a"], next: "a" });
  expect(result.second).toEqual({ ids: ["b"] });
  expect(result.all.ids).toEqual(["a", "b", "c", "local"]);
  expect(result.one.ids).toEqual(["b"]);
  expect(result.two.ids).toEqual(["a", "c"]);
  expect(result.projected.entries).toEqual([]);
});

test("retries database opening with a new handle after a transient failure", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    const { createArtifactStore } = await import(
      "/src/features/artifact-storage/store.ts"
    );
    const store = createArtifactStore("viewer", "relay");
    const definition = {
      name: "retry",
      type: "test.task",
      version: 1,
      project: () => [],
    };
    const original = IDBFactory.prototype.open;
    let attempts = 0;
    IDBFactory.prototype.open = function (...args) {
      if (++attempts === 1)
        throw new DOMException("Temporary open failure", "UnknownError");
      return original.apply(this, args);
    };
    try {
      const failed = store.collection("test", definition);
      const error = await failed.get("task").then(
        () => "unexpected",
        (e) => e.message,
      );
      failed.close();
      const retried = store.collection("test", definition);
      await retried.importBatch({ records: [{ id: "task", local: {} }] });
      return { error, attempts, saved: !!(await retried.get("task")) };
    } finally {
      IDBFactory.prototype.open = original;
      store.close();
    }
  });
  expect(result).toEqual({
    error: "Temporary open failure",
    attempts: 2,
    saved: true,
  });
});

test("direct reads do not wait for an index-only transaction", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    const c = window.artifactTest.open();
    await c.importBatch({
      records: [{ id: "task", local: { title: "saved" } }],
    });
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("buzz-artifacts-v1", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction("entries", "readwrite");
    let held = true;
    const release = () => {
      held = false;
      tx.abort();
    };
    const timeout = setTimeout(release, 5000);
    const keepActive = () => {
      if (held) tx.objectStore("entries").count().onsuccess = keepActive;
    };
    keepActive();
    try {
      const row = await c.get("task");
      await c.preferences.get("task");
      const ids = await c.knownIds({ limit: 10 });
      const error = await c.refreshError();
      const checkpoint = await c.checkpoint();
      return { held, row, ids, error, checkpoint };
    } finally {
      clearTimeout(timeout);
      if (held) release();
      db.close();
    }
  });
  expect(result.held).toBe(true);
  expect(result.row.record.local).toEqual({ title: "saved" });
  expect(result.ids.ids).toEqual(["task"]);
  expect(result.error).toBeNull();
  expect(result.checkpoint).toBeNull();
});
