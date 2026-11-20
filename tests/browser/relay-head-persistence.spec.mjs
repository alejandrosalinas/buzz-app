import { test, expect } from "./source-fixture.mjs";

test("cached heads preserve the budget through an aborted save and version 2 cleanup", async ({
  page,
  context,
  sourceOrigin,
}) => {
  const url = `${sourceOrigin}/relay-head-persistence-test`;
  await context.route(url, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto(url);
  const result = await page.evaluate(async () => {
    const { createHeadPersistence } = await import(
      "/src/features/relay/persistence.ts"
    );
    const relay = "https://example.org";
    const viewers = ["viewer-a", "viewer-b"];
    const now = Date.now();
    const head = (i) => ({
      channelId: `channel-${i}`,
      events: [{ content: `message-${i}` }],
      profiles: [],
      savedAt: now - 100 + i,
    });
    const scopes = viewers.map((viewer) => `${viewer}:${relay}`);
    const openV2 = () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("buzz-channel-heads-v1", 2);
        request.onupgradeneeded = () => {
          request.result.createObjectStore("heads", { keyPath: "key" });
          request.result.createObjectStore("startup", { keyPath: "key" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const writeV2 = async (names, write) => {
      const db = await openV2();
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(names, "readwrite");
          write(tx);
          tx.oncomplete = resolve;
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    };
    await writeV2("heads", (tx) => {
      for (let i = 0; i < 64; i++) {
        const row = head(i);
        const scope = scopes[i % 2];
        tx.objectStore("heads").put({
          ...row,
          scope,
          key: `${scope}:${row.channelId}`,
          bytes: JSON.stringify(row).length,
        });
      }
    });

    let stores = viewers.map((viewer) => createHeadPersistence(viewer, relay));
    const snapshot = () => Promise.all(stores.map((store) => store.read()));
    await stores[1].write(head(63));
    const initialized = await snapshot();
    const prototype = IDBObjectStore.prototype;
    const methods = ["get", "getAll", "openCursor"];
    const read = methods.map((method) => prototype[method]);
    const remove = prototype.delete;
    let saving = false;
    let fullHeadReads = 0;
    let abortSave = true;
    let overlappingRemove;
    for (const [i, method] of methods.entries()) {
      prototype[method] = function (...args) {
        const query = args[0];
        if (
          saving &&
          this.name === "heads" &&
          !Array.isArray(query) &&
          !Array.isArray(query?.lower)
        )
          fullHeadReads++;
        return read[i].apply(this, args);
      };
    }
    prototype.delete = function (key) {
      const request = remove.call(this, key);
      if (this.name === "heads" && key === `${scopes[0]}:channel-0`) {
        if (abortSave) queueMicrotask(() => this.transaction.abort());
        else overlappingRemove = stores[1].remove("channel-63");
      }
      return request;
    };
    try {
      const retry = head(64);
      const aborted = await stores[0].write(retry).then(
        () => false,
        () => true,
      );
      const rolledBack = await snapshot();
      abortSave = false;
      saving = true;
      await stores[0].write(retry);
      await overlappingRemove;
      // A removed head must free its slot in the shared budget.
      await stores[0].write(head(65));
      saving = false;
      for (const store of stores) store.close();
      stores = viewers.map((viewer) => createHeadPersistence(viewer, relay));
      const reopened = await snapshot();
      // A version 2 point delete removes the history but leaves its metadata.
      await writeV2("heads", (tx) => {
        tx.objectStore("heads").delete(`${scopes[1]}:channel-59`);
      });
      const replacement = head(66);
      await stores[1].write(replacement);
      saving = true;
      await stores[1].write(replacement);
      saving = false;
      const refilled = await snapshot();
      const legacyOverwrite = {
        ...head(65),
        events: [{ content: "saved by version 2" }],
      };
      let legacyVisible;
      await writeV2("heads", (tx) => {
        const heads = tx.objectStore("heads");
        const rows = heads.getAll();
        rows.onsuccess = () => {
          // A v2 reader restores recent rows. Its next write prunes expired
          // rows, including any metadata the current build added.
          const cutoff = Date.now() - 24 * 60 * 60 * 1000;
          legacyVisible = scopes.map((scope) =>
            rows.result
              .filter((row) => row.scope === scope && row.savedAt > cutoff)
              .sort((a, b) => b.savedAt - a.savedAt)
              .slice(0, 64),
          );
          heads.put({
            ...legacyOverwrite,
            key: `${scopes[0]}:channel-65`,
            scope: scopes[0],
            bytes: JSON.stringify(legacyOverwrite).length,
          });
          for (const row of rows.result)
            if (row.savedAt <= cutoff) heads.delete(row.key);
        };
      });
      const ordinaryReads = fullHeadReads;
      saving = true;
      await stores[1].write(replacement);
      const rebuildReads = fullHeadReads - ordinaryReads;
      fullHeadReads = ordinaryReads;
      await stores[1].write(replacement);
      saving = false;
      const rebuilt = await snapshot();
      await Promise.all(
        stores.map((store) => store.writeProfiles(["profile"])),
      );
      for (const store of stores) store.close();

      await writeV2(["heads", "startup"], (tx) => {
        // The shipped version 2 clear removes these startup keys and all
        // stored heads for the selected viewer and community.
        const startup = tx.objectStore("startup");
        startup.delete(scopes[0]);
        startup.delete(`${scopes[0]}:profiles`);
        const heads = tx.objectStore("heads");
        // Leave an orphan in the other scope for the current clear to remove.
        heads.delete(`${scopes[1]}:channel-61`);
        const rows = heads.getAll();
        rows.onsuccess = () => {
          for (const row of rows.result)
            if (row.scope === scopes[0]) heads.delete(row.key);
        };
      });
      stores = viewers.map((viewer) => createHeadPersistence(viewer, relay));
      const afterLegacyClear = await snapshot();
      const profiles = await Promise.all(
        stores.map((store) => store.readProfiles()),
      );
      await stores[1].clear();
      const inspection = await openV2();
      const remaining = await new Promise((resolve, reject) => {
        const tx = inspection.transaction("heads");
        const count = tx.objectStore("heads").count();
        tx.oncomplete = () => resolve(count.result);
        tx.onabort = () => reject(tx.error);
      });
      inspection.close();
      const content = "x".repeat(3 * 1024 * 1024);
      for (const i of [67, 68, 69])
        await stores[i % 2].write({ ...head(i), events: [{ content }] });
      const underByteLimit = (await snapshot()).map((rows) =>
        rows.map((row) => row.channelId),
      );
      return {
        initialized,
        rolledBack,
        aborted,
        fullHeadReads,
        reopened,
        refilled,
        legacyVisible,
        rebuilt,
        rebuildReads,
        afterLegacyClear,
        profiles,
        remaining,
        underByteLimit,
      };
    } finally {
      for (const [i, method] of methods.entries()) prototype[method] = read[i];
      prototype.delete = remove;
      for (const store of stores) store.close();
    }
  });
  expect(result.initialized.map((rows) => rows.length)).toEqual([32, 32]);
  expect(result.initialized[0][0].events).toEqual([{ content: "message-62" }]);
  expect(result.initialized[1][0].events).toEqual([{ content: "message-63" }]);
  expect(result.aborted).toBe(true);
  expect(result.rolledBack).toEqual(result.initialized);
  expect(result.reopened[0].slice(0, 2).map((row) => row.channelId)).toEqual([
    "channel-65",
    "channel-64",
  ]);
  expect(result.reopened[0].slice(2)).toEqual(
    result.initialized[0].slice(0, -1),
  );
  expect(result.reopened[1]).toEqual(result.initialized[1].slice(1));
  expect(result.refilled[0]).toEqual(result.reopened[0]);
  expect(result.refilled[1][0].channelId).toBe("channel-66");
  expect(result.refilled[1].slice(1)).toEqual(
    result.reopened[1].filter((row) => row.channelId !== "channel-59"),
  );
  expect(result.legacyVisible).toEqual(result.refilled);
  expect(result.rebuildReads).toBe(1);
  expect(result.rebuilt[0][0].events).toEqual([
    { content: "saved by version 2" },
  ]);
  expect(result.rebuilt[0].slice(1)).toEqual(result.refilled[0].slice(1));
  expect(result.rebuilt[1]).toEqual(result.refilled[1]);
  expect(result.fullHeadReads).toBe(0);
  expect(result.afterLegacyClear).toEqual([
    [],
    result.refilled[1].filter((row) => row.channelId !== "channel-61"),
  ]);
  expect(result.profiles).toEqual([[], ["profile"]]);
  expect(result.remaining).toBe(0);
  expect(result.underByteLimit).toEqual([["channel-68"], ["channel-69"]]);
});
