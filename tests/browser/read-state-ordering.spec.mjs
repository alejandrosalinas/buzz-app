import { test, expect } from "./source-fixture.mjs";
import { stopRoutes } from "./playwright-test.mjs";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import {
  signReadState,
  decodeReadState,
} from "../../browser-host/read-state.mjs";

// Real IndexedDB connections must reserve the read-start snapshot before the
// owner queue resumes; the Node owner tests cannot establish that browser order.
for (const { alreadyIngested, redeliver } of [
  { alreadyIngested: false, redeliver: true },
  { alreadyIngested: true, redeliver: true },
  { alreadyIngested: false, redeliver: false },
  { alreadyIngested: true, redeliver: false },
]) {
  test(`read-start capture separates peer ingest before invocation: ${alreadyIngested}, redeliver: ${redeliver}`, async ({
    page,
    context,
    sourceOrigin,
  }) => {
    const secret = generateSecretKey();
    const viewer = getPublicKey(secret);
    const key = `msg:${"a".repeat(64)}`;
    const marker = signReadState(
      {
        slot: "b".repeat(32),
        createdAt: 100,
        blob: {
          v: 1,
          client_id: "peer",
          contexts: {
            [`ov_s:${key}`]: 1,
            [`ov_c:${key}`]: 0,
            [`ov_b:${key}`]: 0,
          },
        },
      },
      secret,
      100,
    );
    await context.route(`${sourceOrigin}/read-ordering`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Read ordering</title>",
      }),
    );
    const peer = await context.newPage();
    for (const window of [page, peer]) {
      await window.exposeFunction("decodeMarkers", (events) =>
        decodeReadState(events, secret),
      );
      await window.goto(`${sourceOrigin}/read-ordering`);
      await window.evaluate(
        async ({ viewer }) => {
          const { createReadState } = await import(
            "/src/features/relay/read-state.ts"
          );
          const { browserReadStateStorage } = await import(
            "/src/features/relay/read-state-storage.ts"
          );
          window.store = browserReadStateStorage("read-ordering", viewer);
          window.owner = createReadState({
            viewer,
            storage: window.store,
            reader: { read: async () => [] },
            host: {
              decode: window.decodeMarkers,
              sign: async () => {
                throw new Error("No signing in ordering test");
              },
              publish: async () => {},
            },
            lock: async (_signal, work) => work(),
            now: () => 100,
            debounceMs: 60000,
          });
          await window.owner.ready;
        },
        { viewer },
      );
    }
    try {
      // Hold the queue BEFORE reserving an actual save transaction. No
      // broadcast or pre-refresh is allowed to freshen this window's cache.
      await peer.evaluate(async () => {
        const update = window.store.update.bind(window.store);
        let started;
        const held = new Promise((resolve) => {
          started = resolve;
        });
        const gate = new Promise((resolve) => {
          window.releaseHold = resolve;
        });
        window.store.update = async (change) => {
          window.store.update = update;
          started();
          await gate;
          return update(change);
        };
        window.queued = window.owner.learnHomes({}).then(
          () => null,
          (error) => error.message,
        );
        await held;
      });
      const ingest = () =>
        page.evaluate(async (marker) => {
          window.owner.accept([marker]);
          await window.owner.learnHomes({});
        }, marker);
      if (alreadyIngested) await ingest();
      await peer.evaluate((key) => {
        window.reading = window.owner
          .read(key, 11, () => true)
          .then(
            () => null,
            (error) => error.message,
          );
      }, key);
      if (!alreadyIngested) await ingest();
      if (redeliver)
        await peer.evaluate((marker) => window.owner.accept([marker]), marker);
      const result = await peer.evaluate(async (key) => {
        window.releaseHold();
        const errors = await Promise.all([window.queued, window.reading]);
        await window.owner.learnHomes({});
        const journal = await window.store.read();
        const { overrideActive } = await import(
          "/src/features/relay/read-state-model.ts"
        );
        return {
          errors,
          frontier: journal.state.frontiers[key],
          baseline: journal.state.overrides[key].baseline,
          unread: overrideActive(
            journal.state.overrides[key],
            journal.state.frontiers[key],
          ),
          pending: journal.peerOverlaps ?? [],
        };
      }, key);
      expect(result).toEqual({
        errors: [null, null],
        frontier: 11,
        baseline: alreadyIngested ? 0 : 11,
        unread: !alreadyIngested,
        pending: [],
      });
    } finally {
      for (const window of [page, peer])
        await window.evaluate(() => {
          window.releaseHold?.();
          window.owner?.dispose();
        });
      await stopRoutes(context);
      await peer.close();
    }
  });
}

test("capture rejects cold or closed storage instead of deferring its reservation", async ({
  page,
  context,
  sourceOrigin,
}) => {
  await context.route(`${sourceOrigin}/capture-lifecycle`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Capture lifecycle</title>",
    }),
  );
  await page.goto(`${sourceOrigin}/capture-lifecycle`);
  const result = await page.evaluate(async () => {
    const { browserReadStateStorage } = await import(
      "/src/features/relay/read-state-storage.ts"
    );
    const store = browserReadStateStorage("capture-lifecycle", "a".repeat(64));
    const error = (work) =>
      work.then(
        () => null,
        (cause) => cause.message,
      );
    let owner;
    try {
      const cold = await error(store.capture());
      const { createReadState } = await import(
        "/src/features/relay/read-state.ts"
      );
      owner = createReadState({
        viewer: "a".repeat(64),
        storage: store,
        reader: { read: async () => [] },
        host: {
          decode: async () => [],
          sign: async () => {
            throw new Error("No signing in lifecycle test");
          },
          publish: async () => {},
        },
        lock: async (_signal, work) => work(),
        debounceMs: 60000,
      });
      const early = await error(owner.read("msg:early", 11, () => true));
      await owner.ready;
      const untouched = owner.state().frontiers["msg:early"];
      await owner.read("msg:early", 11, () => true);
      const retried = owner.state().frontiers["msg:early"];
      const captured = store.capture();
      await store.update((current) => ({ ...current, revision: 2 }));
      const before = await captured;
      const after = await store.capture();
      owner.dispose();
      const closed = await error(store.capture());
      return {
        cold,
        early,
        untouched,
        retried,
        before: before.revision,
        after: after.revision,
        closed,
      };
    } finally {
      owner?.dispose();
      store.close();
    }
  });
  expect(result).toEqual({
    cold: "Read-state storage not ready",
    early: "Read-state storage not ready",
    untouched: undefined,
    retried: 11,
    before: 1,
    after: 2,
    closed: "Read-state storage not ready",
  });
});
