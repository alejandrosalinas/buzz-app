import { test, expect } from "./source-fixture.mjs";

// Exercise the actual incremental IndexedDB journal: a full-array memory store
// cannot reproduce a stale window deleting another window's renewed receipt.
test("forgetting a stale receipt relinquishes its journal deletion ownership", async ({
  page,
  context,
  sourceOrigin,
}) => {
  await context.route(`${sourceOrigin}/outbox-storage-test`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Outbox storage boundary</title>",
    }),
  );
  await page.goto(`${sourceOrigin}/outbox-storage-test`);
  const ids = await page.evaluate(async () => {
    const { browserOutboxStorage, purgeOutboxStorage } = await import(
      "/src/features/relay/outbox-storage.ts"
    );
    const scope = `stale-receipt-${crypto.randomUUID()}`;
    const owner = browserOutboxStorage(scope);
    const stale = browserOutboxStorage(scope);
    const old = { event: { id: "old" }, delivery: "failed" };
    const next = { event: { id: "next" }, delivery: "sending" };
    try {
      await owner.load();
      await owner.save([old]);
      await stale.load();
      await owner.save([]);
      if ((await stale.load({ readOnly: true })).length)
        throw new Error("Receipt was not removed");
      const pending = stale.save([old]);
      // save has entered its IndexedDB transaction, which cannot complete in
      // this microtask. Discard must survive that transaction's completion.
      await Promise.resolve();
      stale.forget(old.event.id);
      await pending;
      // A different window renews the same operation after the absence check.
      await owner.save([old]);
      await stale.save([next]);
      return (await owner.load({ readOnly: true }))
        .map((item) => item.event.id)
        .sort();
    } finally {
      owner.close();
      stale.close();
      await purgeOutboxStorage(scope);
    }
  });
  expect(ids).toEqual(["next", "old"]);
});

for (const journal of ["indexeddb", "legacy"])
  test(`a late creation echo respects durable setup removal (${journal})`, async ({
    page,
    context,
    sourceOrigin,
  }) => {
    await context.route(`${sourceOrigin}/outbox-storage-test`, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    await page.goto(`${sourceOrigin}/outbox-storage-test`);
    const { finalizeEvent } = await import("nostr-tools");
    const member = "a".repeat(64);
    const creation = finalizeEvent(
      {
        kind: 9007,
        created_at: 1,
        content: "",
        tags: [
          ["h", "chat"],
          ["p", member],
        ],
      },
      new Uint8Array(32).fill(7),
    );
    const result = await page.evaluate(
      async ({ creation, member, journal }) => {
        const { browserOutboxStorage, purgeOutboxStorage } = await import(
          "/src/features/relay/outbox-storage.ts"
        );
        const { createOutbox } = await import("/src/features/relay/outbox.ts");
        const { soloAdminRecovery } = await import(
          "/src/features/relay/solo-admins.ts"
        );
        const recovery = soloAdminRecovery("chat", [member], [member]);
        const scope = `setup-removal-${crypto.randomUUID()}`;
        const aStore = browserOutboxStorage(scope);
        const bStore = browserOutboxStorage(scope);
        const operation = {
          event: creation,
          signed: creation,
          recovery,
          delivery: "accepted",
        };
        if (journal === "legacy")
          localStorage.setItem(
            `buzz-outbox-v1:${scope}`,
            JSON.stringify([operation]),
          );
        else await aStore.save([operation]);
        const unexpected = async () => {
          throw new Error("Unexpected delivery");
        };
        const writer = { sign: unexpected, publish: unexpected };
        const a = createOutbox(creation.pubkey, writer, aStore);
        const b = createOutbox(creation.pubkey, writer, bStore);
        try {
          await Promise.all([a.ready, b.ready]);
          if (
            !a.outbox.snapshot()[0]?.recovery ||
            !b.outbox.snapshot()[0]?.recovery
          )
            throw new Error("Both windows must hold the saved setup");
          b.observe([creation]);
          await b.outbox.dismiss(creation.id, recovery);
          const afterDismiss = (await bStore.load({ readOnly: true })).length;
          a.observe([creation]);
          let ran = false;
          const publication = await a.outbox
            .withRecovery(creation.id, recovery, async () => {
              ran = true;
            })
            .then(
              () => "completed",
              (error) => error.message,
            );
          const completion = await a.outbox
            .finishRecovery(creation.id, recovery)
            .then(
              () => "completed",
              (error) => error.message,
            );
          return {
            afterDismiss,
            ran,
            publication,
            completion,
            remaining: (await bStore.load({ readOnly: true })).length,
          };
        } finally {
          a.dispose();
          b.dispose();
          await purgeOutboxStorage(scope);
        }
      },
      { creation, member, journal },
    );
    expect(result).toEqual({
      afterDismiss: 0,
      ran: false,
      publication: expect.stringContaining(
        "removed or changed in another window",
      ),
      completion: expect.stringContaining(
        "removed or changed in another window",
      ),
      remaining: 0,
    });
  });

for (const mode of ["dismiss-first", "adopt-first", "peer-accepted"])
  test(`receipt adoption serializes queue consumption with dismissal (${mode})`, async ({
    page,
    context,
    sourceOrigin,
  }) => {
    await context.route(`${sourceOrigin}/outbox-adoption-test`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Outbox adoption</title>",
      }),
    );
    await page.goto(`${sourceOrigin}/outbox-adoption-test`);
    const { finalizeEvent } = await import("nostr-tools");
    const event = finalizeEvent(
      {
        kind: 9,
        created_at: 1,
        content: "Saved message",
        tags: [["h", "chat"]],
      },
      new Uint8Array(32).fill(7),
    );
    const result = await page.evaluate(
      async ({ event, mode }) => {
        const { browserOutboxStorage, purgeOutboxStorage } = await import(
          "/src/features/relay/outbox-storage.ts"
        );
        const { createOutbox } = await import("/src/features/relay/outbox.ts");
        const recovery = { key: "follow-up:row", value: "row" };
        const scope = `adoption-${crypto.randomUUID()}`;
        const seed = browserOutboxStorage(scope);
        await seed.load();
        await seed.save([
          { event, signed: event, recovery, delivery: "failed" },
        ]);
        seed.close();
        const writer = {
          sign: async () => {
            throw new Error("Unexpected signing");
          },
          publish: async () => {
            throw new Error("Unexpected publishing");
          },
        };
        const a = createOutbox(
          event.pubkey,
          writer,
          browserOutboxStorage(scope),
        );
        const store = browserOutboxStorage(scope);
        let started;
        const saving = new Promise((resolve) => {
          started = resolve;
        });
        let resume;
        const gate = new Promise((resolve) => {
          resume = resolve;
        });
        const b = createOutbox(event.pubkey, writer, {
          ...store,
          load: async (options) => {
            const records = await store.load(options);
            if (options?.readOnly) {
              started();
              await gate;
            }
            return records;
          },
        });
        try {
          await Promise.all([a.ready, b.ready]);
          const order = [];
          if (mode === "dismiss-first") {
            resume();
            await b.outbox.recovery(recovery.key);
            await a.outbox.dismiss(event.id);
            let rejected = false;
            try {
              await b.outbox.recover(event.id, recovery, () =>
                order.push("consumed"),
              );
            } catch {
              rejected = true;
            }
            return {
              order,
              rejected,
              remaining: (await store.load({ readOnly: true })).length,
            };
          }
          const adoption = b.outbox.recover(event.id, recovery, () =>
            order.push("consumed"),
          );
          await saving;
          if (mode === "peer-accepted") {
            const peer = browserOutboxStorage(scope);
            await peer.load();
            await peer.save([
              { event, signed: event, recovery, delivery: "accepted" },
            ]);
            peer.close();
            resume();
            await adoption;
            return {
              order,
              delivery: (await store.load({ readOnly: true }))[0]?.delivery,
            };
          }
          // Dismissal must wait while adoption persists and consumes its source row.
          const dismissal = a.outbox
            .dismiss(event.id)
            .then(() => order.push("dismissed"));
          resume();
          await Promise.all([adoption, dismissal]);
          const after = await store.load({ readOnly: true });
          return { order, remaining: after.length };
        } finally {
          a.dispose();
          b.dispose();
          await purgeOutboxStorage(scope);
        }
      },
      { event, mode },
    );
    expect(result).toEqual(
      mode === "dismiss-first"
        ? { order: [], rejected: true, remaining: 0 }
        : mode === "peer-accepted"
          ? { order: ["consumed"], delivery: "accepted" }
          : { order: ["consumed", "dismissed"], remaining: 0 },
    );
  });
