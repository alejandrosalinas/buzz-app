import { Context } from "@deepseek-ai/cordis";
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { setImmediate as settle } from "node:timers/promises";
import { PluginRuntime } from "./runtime.ts";
import { PagesService } from "../features/pages/service.ts";

afterEach(() => vi.useRealTimers());

const Page = () => null;
function plugin(id = "example.page", revision = "one", enabled = true) {
  return {
    manifest: { id, name: id, apiVersion: 1 },
    source: "external",
    revision,
    enabled,
    previous: null,
    reloadable: true,
    error: null,
  };
}
function desired(plugins) {
  return plugins.filter((plugin) => plugin.enabled);
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(load, timeoutMs) {
  let states = {};
  const waiters = new Set();
  const root = new Context();
  const runtime = new PluginRuntime(
    root,
    async (plugin) => ({ inject: ["pages"], ...(await load(plugin)) }),
    timeoutMs,
  );
  runtime.subscribe(() => {
    states = runtime.snapshot();
    for (const check of [...waiters]) check();
  });
  const pages = new PagesService(root);
  return {
    runtime,
    async dispose() {
      try {
        await runtime.dispose();
      } finally {
        await root.fiber.dispose();
      }
    },
    root,
    pages,
    wait(predicate) {
      if (predicate(states)) return Promise.resolve(states);
      return new Promise((resolve) => {
        const check = () => {
          if (predicate(states)) {
            waiters.delete(check);
            resolve(states);
          }
        };
        waiters.add(check);
      });
    },
    get states() {
      return states;
    },
  };
}

test("pages wait for dependencies and completion of async activation", async () => {
  const started = deferred();
  const release = deferred();
  let starts = 0;
  const h = harness(async () => ({
    inject: ["pages", "connection"],
    async apply(ctx) {
      starts++;
      ctx.pages.register({ id: "main", title: "Main", component: Page });
      started.resolve();
      await release.promise;
    },
  }));
  try {
    h.runtime.reconcile(desired([plugin()]));
    await settle();
    assert.equal(starts, 0);
    assert.equal(h.states["example.page"].status, "starting");
    assert.equal(h.root.pluginStatus.settled(), false);
    assert.deepEqual(h.pages.snapshot(), []);
    h.root.provide("connection", {});
    await started.promise;
    assert.equal(h.states["example.page"].status, "starting");
    assert.deepEqual(h.pages.snapshot(), []);
    release.resolve();
    await h.wait((s) => s["example.page"]?.status === "active");
    assert.equal(h.pages.snapshot()[0].key, "example.page/main");
    assert.equal(h.root.pluginStatus.settled(), true);
  } finally {
    release.resolve();
    await h.dispose();
  }
});

test("bundled start-up is over while an installed plugin still starts", async () => {
  const release = deferred();
  const h = harness(async (info) =>
    info.source === "external"
      ? { inject: ["pages"], apply: () => release.promise }
      : { inject: ["pages"], apply() {} },
  );
  try {
    h.runtime.reconcile([
      { ...plugin("example.bundled"), source: "bundled", revision: "bundled" },
      plugin("example.slow"),
    ]);
    await h.wait((s) => s["example.bundled"]?.status === "active");
    assert.equal(h.states["example.slow"].status, "starting");
    assert.equal(h.root.pluginStatus.settled(), false);
    assert.equal(h.root.pluginStatus.bundledSettled(), true);
    release.resolve();
    await h.wait((s) => s["example.slow"]?.status === "active");
    assert.equal(h.root.pluginStatus.settled(), true);
  } finally {
    release.resolve();
    await h.dispose();
  }
});

test("bundled start-up is not over while a bundled plugin starts", async () => {
  const release = deferred();
  const h = harness(async () => ({
    inject: ["pages"],
    apply: () => release.promise,
  }));
  try {
    h.runtime.reconcile([
      { ...plugin("example.bundled"), source: "bundled", revision: "bundled" },
    ]);
    await settle();
    assert.equal(h.root.pluginStatus.bundledSettled(), false);
    release.resolve();
    await h.wait((s) => s["example.bundled"]?.status === "active");
    assert.equal(h.root.pluginStatus.bundledSettled(), true);
  } finally {
    release.resolve();
    await h.dispose();
  }
});

test("startup is not over while the plugin settings are being read", async () => {
  let configuring = true;
  const root = new Context();
  const runtime = new PluginRuntime(
    root,
    async () => ({ apply() {} }),
    undefined,
    () => configuring,
  );
  try {
    assert.equal(root.pluginStatus.settled(), false);
    assert.equal(root.pluginStatus.bundledSettled(), false);
    configuring = false;
    assert.equal(root.pluginStatus.settled(), true);
    assert.equal(root.pluginStatus.bundledSettled(), true);
  } finally {
    await runtime.dispose();
    await root.fiber.dispose();
  }
});

test("missing dependencies time out and cannot activate late", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let starts = 0;
  const h = harness(async () => ({
    inject: ["connection"],
    apply() {
      starts++;
    },
  }));
  try {
    h.runtime.reconcile(desired([plugin()]));
    await settle();
    vi.advanceTimersByTime(10_001);
    await h.wait((s) => s["example.page"]?.status === "failed");
    assert.match(h.states["example.page"].error, /activation timed out/);
    h.root.provide("connection", {});
    await settle();
    assert.equal(starts, 0);
    assert.equal(h.states["example.page"].status, "failed");
  } finally {
    await h.dispose();
  }
});

test("dependency changes hide pages until reactivation and report later failures", async () => {
  const restarting = deferred();
  const release = deferred();
  let starts = 0;
  const h = harness(async () => ({
    inject: ["pages", "connection"],
    async apply(ctx) {
      starts++;
      ctx.pages.register({ id: "main", title: "Main", component: Page });
      if (starts === 2) {
        restarting.resolve();
        await release.promise;
      }
      if (starts === 3) throw new Error("Connection restart failed");
    },
  }));
  const connect = () =>
    h.root.plugin((ctx) => {
      ctx.provide("connection", {});
    });
  try {
    let provider = connect();
    h.runtime.reconcile(desired([plugin()]));
    await h.wait((s) => s["example.page"]?.status === "active");
    assert.equal(h.pages.snapshot().length, 1);
    await provider.dispose();
    assert.equal(h.states["example.page"].status, "starting");
    assert.deepEqual(h.pages.snapshot(), []);
    provider = connect();
    await restarting.promise;
    assert.equal(h.states["example.page"].status, "starting");
    assert.deepEqual(h.pages.snapshot(), []);
    release.resolve();
    await h.wait((s) => s["example.page"]?.status === "active");
    assert.equal(h.pages.snapshot().length, 1);
    await provider.dispose();
    connect();
    await h.wait((s) => s["example.page"]?.status === "failed");
    assert.match(h.states["example.page"].error, /Connection restart failed/);
    assert.deepEqual(h.pages.snapshot(), []);
    h.runtime.reconcile(desired([plugin()]));
    await settle();
    assert.equal(starts, 3);
  } finally {
    release.resolve();
    await h.dispose();
  }
});

test("a lost dependency has a new deadline after successful activation", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const h = harness(async () => ({
    inject: ["pages", "connection"],
    apply(ctx) {
      ctx.pages.register({ id: "main", title: "Main", component: Page });
    },
  }));
  try {
    const provider = h.root.plugin((ctx) => {
      ctx.provide("connection", {});
    });
    h.runtime.reconcile(desired([plugin()]));
    await h.wait((s) => s["example.page"]?.status === "active");
    vi.advanceTimersByTime(20_000);
    assert.equal(h.states["example.page"].status, "active");
    await provider.dispose();
    vi.advanceTimersByTime(10_001);
    await h.wait((s) => s["example.page"]?.status === "failed");
    assert.match(h.states["example.page"].error, /activation timed out/);
    assert.deepEqual(h.pages.snapshot(), []);
  } finally {
    await h.dispose();
  }
});

test("enabled plugin stays active across catalog refreshes and cleans up on disable", async () => {
  let starts = 0;
  let cleanups = 0;
  const h = harness(async () => ({
    apply(ctx) {
      starts++;
      ctx.effect(() => () => {
        cleanups++;
      });
      ctx.pages.register({ id: "main", title: "Main", component: Page });
    },
  }));
  h.runtime.reconcile(desired([plugin()]));
  await h.wait((s) => s["example.page"]?.status === "active");
  h.runtime.reconcile(desired([plugin()]));
  assert.equal(starts, 1);
  h.runtime.reconcile(desired([plugin("example.page", "one", false)]));
  await h.dispose();
  assert.equal(cleanups, 1);
  assert.equal(h.states["example.page"], undefined);
});

test("a plugin's declared host access is readable only while the plugin is active", async () => {
  const gate = deferred();
  const h = harness(async () => ({
    async apply(ctx) {
      await gate.promise;
      ctx.pages.register({ id: "main", title: "Main", component: Page });
    },
  }));
  const declared = {
    ...plugin(),
    manifest: {
      ...plugin().manifest,
      host: { agentPromptSections: ["progress"] },
    },
  };
  try {
    assert.equal(h.root.pluginStatus.promptSections("example.page"), undefined);
    assert.equal(h.root.pluginStatus.on("example.page"), false);
    h.runtime.reconcile(desired([declared]));
    await h.wait((s) => s["example.page"]?.status === "starting");
    assert.equal(h.root.pluginStatus.promptSections("example.page"), undefined);
    // It is on before it is active.
    assert.equal(h.root.pluginStatus.on("example.page"), true);
    gate.resolve();
    await h.wait((s) => s["example.page"]?.status === "active");
    assert.deepEqual(h.root.pluginStatus.promptSections("example.page"), [
      "progress",
    ]);
    assert.equal(
      h.root.pluginStatus.promptSections("example.other"),
      undefined,
    );
    assert.equal(h.root.pluginStatus.on("example.other"), false);
    h.runtime.reconcile(desired([{ ...declared, enabled: false }]));
    assert.equal(h.root.pluginStatus.promptSections("example.page"), undefined);
    assert.equal(h.root.pluginStatus.on("example.page"), false);
  } finally {
    gate.resolve();
    await h.dispose();
  }
});

test("a plugin that failed to start is still on, with no declared access to read", async () => {
  const h = harness(async () => ({
    apply() {
      throw new Error("no start");
    },
  }));
  try {
    h.runtime.reconcile(desired([plugin()]));
    await h.wait((s) => s["example.page"]?.status === "failed");
    assert.equal(h.root.pluginStatus.on("example.page"), true);
    assert.equal(h.root.pluginStatus.promptSections("example.page"), undefined);
  } finally {
    await h.dispose();
  }
});

test("replacement and rapid disable/enable wait for async cleanup", async () => {
  const cleanup = deferred();
  const stopping = deferred();
  const started = [];
  const h = harness(async (p) => ({
    apply(ctx) {
      started.push(p.revision);
      if (p.revision === "one")
        ctx.effect(() => async () => {
          stopping.resolve();
          await cleanup.promise;
        });
      ctx.pages.register({ id: "main", title: "Main", component: Page });
    },
  }));
  h.runtime.reconcile(desired([plugin()]));
  await h.wait((s) => s["example.page"]?.status === "active");
  h.runtime.reconcile(desired([plugin("example.page", "two")]));
  await stopping.promise;
  h.runtime.reconcile(desired([]));
  h.runtime.reconcile(desired([plugin("example.page", "three")]));
  assert.deepEqual(started, ["one"]);
  cleanup.resolve();
  await h.wait(
    (s) =>
      s["example.page"]?.status === "active" &&
      s["example.page"].revision === "three",
  );
  assert.deepEqual(started, ["one", "three"]);
  await h.dispose();
});

test("late module resolution cannot activate after disable or teardown", async () => {
  const loading = deferred();
  let starts = 0;
  const h = harness(() => loading.promise);
  h.runtime.reconcile(desired([plugin()]));
  h.runtime.reconcile(desired([]));
  loading.resolve({
    apply() {
      starts++;
    },
  });
  await h.dispose();
  assert.equal(starts, 0);
});

test("failed activation disposes effects, leaves other plugins usable, and retries explicitly", async () => {
  let cleanup = 0;
  let attempts = 0;
  const cleaned = deferred();
  const h = harness(async (p) => ({
    apply(ctx) {
      ctx.pages.register({ id: "main", title: "Main", component: Page });
      if (p.manifest.id === "bad") {
        attempts++;
        ctx.effect(() => () => {
          cleanup++;
          cleaned.resolve();
        });
        throw new Error("broken startup");
      }
    },
  }));
  const both = desired([plugin("bad"), plugin("good")]);
  h.runtime.reconcile(both);
  await h.wait((s) => s.bad?.error && s.good?.status === "active");
  await cleaned.promise;
  assert.match(h.states.bad.error, /broken startup/);
  assert.equal(
    h.pages.snapshot().some((p) => p.pluginId === "bad"),
    false,
  );
  assert.equal(cleanup, 1);
  h.runtime.reconcile(both);
  assert.equal(attempts, 1);
  h.runtime.reconcile(desired([plugin("good")]));
  h.runtime.reconcile(both);
  await h.wait((s) => s.bad?.error);
  assert.equal(attempts, 2);
  await h.dispose();
});

test("plugins may have no pages; duplicate page IDs fail cleanly", async () => {
  const h = harness(async (p) => ({
    apply(ctx) {
      if (p.manifest.id === "duplicate") {
        ctx.pages.register({ id: "main", title: "Main", component: Page });
        ctx.pages.register({ id: "main", title: "Main", component: Page });
      }
    },
  }));
  h.runtime.reconcile(desired([plugin("missing"), plugin("duplicate")]));
  await h.wait((s) => s.missing?.status === "active" && s.duplicate?.error);
  assert.equal(h.states.missing.error, null);
  assert.match(h.states.duplicate.error, /already registered/);
  await h.dispose();
});

test("activation timeout reports failure and rejects late resource registration", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const started = deferred();
  const release = deferred();
  const finished = deferred();
  let lateEffect = false;
  const h = harness(async () => ({
    async apply(ctx) {
      started.resolve();
      await release.promise;
      try {
        ctx.effect(() => {
          lateEffect = true;
          return () => {};
        });
        ctx.pages.register({ id: "main", title: "Main", component: Page });
      } finally {
        finished.resolve();
      }
    },
  }));
  h.runtime.reconcile(desired([plugin()]));
  await started.promise;
  vi.advanceTimersByTime(10_001);
  await h.wait((s) => s["example.page"]?.error);
  assert.match(h.states["example.page"].error, /activation timed out/);
  release.resolve();
  await finished.promise;
  await h.dispose();
  assert.equal(lateEffect, false);
  assert.equal(h.pages.snapshot().length, 0);
});

test("multiple pages belong to their plugin scope and IDs are namespaced", async () => {
  const h = harness(async () => ({
    apply(ctx) {
      ctx.pages.register({
        id: "overview",
        title: "Overview",
        component: Page,
      });
      ctx.pages.register({ id: "details", title: "Details", component: Page });
    },
  }));
  h.runtime.reconcile(desired([plugin("first"), plugin("second")]));
  await h.wait(
    (s) => s.first?.status === "active" && s.second?.status === "active",
  );
  assert.deepEqual(
    h.pages.snapshot().map((p) => p.key),
    ["first/overview", "first/details", "second/overview", "second/details"],
  );
  const removed = new Promise((resolve) => {
    const unsubscribe = h.pages.subscribe(() => {
      if (!h.pages.snapshot().some((p) => p.pluginId === "first")) {
        unsubscribe();
        resolve();
      }
    });
  });
  h.runtime.reconcile(desired([plugin("second")]));
  await removed;
  assert.deepEqual(
    h.pages.snapshot().map((p) => p.key),
    ["second/overview", "second/details"],
  );
  await h.dispose();
  assert.deepEqual(h.pages.snapshot(), []);
});

test("Cordis consumers share the startup value across plugin reactivation", async () => {
  const values = [];
  const h = harness(async () => ({
    inject: ["shared"],
    apply(ctx) {
      values.push(ctx.shared);
    },
  }));
  h.root.provide("shared", Object.freeze({ value: 0.5 }));
  h.runtime.reconcile(desired([plugin("first"), plugin("second")]));
  await h.wait(
    (s) => s.first?.status === "active" && s.second?.status === "active",
  );
  assert.equal(values.length, 2);
  assert.equal(values[0], values[1]);
  assert.ok(values[0].value >= 0 && values[0].value < 1);
  assert.ok(Object.isFrozen(values[0]));
  h.runtime.reconcile(desired([]));
  h.runtime.reconcile(desired([plugin("first")]));
  await h.wait((s) => s.first?.status === "active");
  assert.equal(values.length, 3);
  assert.equal(values[2], values[0]);
  await h.dispose();
});

test("page service attributes child registrations to the plugin and cleans up the child scope", async () => {
  let child;
  const h = harness(async () => ({
    async apply(ctx) {
      child = ctx.inject(["pages"], (scope) => {
        scope.pages.register({ id: "child", title: "Child", component: Page });
      });
      await child.await();
    },
  }));
  h.runtime.reconcile(desired([plugin()]));
  await h.wait((s) => s["example.page"]?.status === "active");
  assert.equal(h.pages.snapshot()[0].key, "example.page/child");
  await child.dispose();
  assert.deepEqual(h.pages.snapshot(), []);
  assert.equal(h.states["example.page"].status, "active");
  await h.dispose();
});

test("a replacement timeout never releases the actual predecessor cleanup barrier", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const cleanup = deferred();
  const starts = [];
  const h = harness(async (p) => ({
    apply(ctx) {
      starts.push(p.revision);
      if (p.revision === "one") ctx.effect(() => () => cleanup.promise);
      ctx.pages.register({ id: "main", title: "Main", component: Page });
    },
  }));
  try {
    h.runtime.reconcile([plugin()]);
    await h.wait((s) => s["example.page"]?.status === "active");
    h.runtime.reconcile([plugin("example.page", "two")]);
    await settle();
    vi.advanceTimersByTime(10_001);
    await h.wait((s) => s["example.page"]?.status === "failed");
    assert.match(
      h.states["example.page"].error,
      /Previous plugin cleanup timed out/,
    );
    assert.deepEqual(starts, ["one"]);
    assert.deepEqual(h.pages.snapshot(), []);
    // Trying a third revision must still wait for revision one's real cleanup.
    h.runtime.reconcile([plugin("example.page", "three")]);
    await settle();
    assert.deepEqual(starts, ["one"]);
    cleanup.resolve();
    await h.wait((s) => s["example.page"]?.status === "active");
    assert.deepEqual(starts, ["one", "three"]);
  } finally {
    cleanup.resolve();
    await h.dispose();
  }
});

test("explicit retry waits for failed cleanup and leaves healthy plugins running", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const cleanup = deferred();
  const started = deferred();
  const activation = deferred();
  let attempts = 0;
  let healthyStarts = 0;
  const h = harness(async (p) => ({
    async apply(ctx) {
      if (p.manifest.id === "bad") {
        attempts++;
        if (attempts === 1) {
          ctx.effect(() => () => cleanup.promise);
          started.resolve();
          await activation.promise;
          return;
        }
      } else healthyStarts++;
      ctx.pages.register({ id: "main", title: "Main", component: Page });
    },
  }));
  const both = [plugin("bad"), plugin("good")];
  try {
    h.runtime.reconcile(both);
    await started.promise;
    await h.wait((s) => s.good?.status === "active");
    vi.advanceTimersByTime(10_001);
    await h.wait((s) => s.bad?.status === "failed");
    h.runtime.reconcile(both, "good");
    await settle();
    assert.equal(healthyStarts, 1);
    h.runtime.reconcile(both, "bad");
    assert.equal(h.states.bad.status, "starting");
    await settle();
    assert.equal(attempts, 1);
    assert.equal(healthyStarts, 1);
    activation.resolve();
    cleanup.resolve();
    await h.wait((s) => s.bad?.status === "active");
    assert.equal(attempts, 2);
    assert.equal(healthyStarts, 1);
    assert.equal(h.states.bad.revision, "one");
    assert.equal(h.pages.snapshot().length, 2);
  } finally {
    activation.resolve();
    cleanup.resolve();
    await h.dispose();
  }
});
