import { afterEach, expect, it, vi } from "vitest";
import { createPluginStorage } from "./storage";
import type { PluginInfo } from "./types";
const bundledPlugin = (id: string, enabled = true): PluginInfo => ({
  manifest: { id, name: id, apiVersion: 1 },
  source: "bundled",
  enabled,
  revision: "bundled",
  previous: null,
  reloadable: false,
  error: null,
});
const catalog = (): PluginInfo[] =>
  ["buzz.channels", "buzz.github"].map((id) => bundledPlugin(id));
afterEach(() => vi.unstubAllGlobals());
it("ignores the retired Welcome setting and changes each bundled plugin independently", async () => {
  const values = new Map([
    ["buzzodz.plugins.v1", JSON.stringify({ version: 1, enabled: false })],
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const installation = createPluginStorage(catalog);
  expect(await installation.getCatalog()).toMatchObject({
    status: "ready",
    catalog: {
      plugins: [{ enabled: true }, { enabled: true }],
    },
  });
  expect(
    await installation.changePlugin("disable", "buzz.github"),
  ).toMatchObject({
    status: "ready",
    catalog: {
      plugins: [{ enabled: true }, { enabled: false }],
    },
  });
  const reopened = createPluginStorage(catalog);
  expect(await reopened.changePlugin("enable", "buzz.channels")).toMatchObject({
    status: "ready",
    catalog: {
      plugins: [{ enabled: true }, { enabled: false }],
    },
  });
});

it("restores required Channels from saved disabled settings and rejects disabling it", async () => {
  const saved = JSON.stringify({
    version: 3,
    enabled: {
      "buzz.channels": false,
      "buzz.github": false,
    },
  });
  const values = new Map([["buzzodz.plugins.v1", saved]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  for (let reopen = 0; reopen < 2; reopen++) {
    const storage = createPluginStorage(catalog);
    expect(await storage.getCatalog()).toMatchObject({
      status: "ready",
      catalog: { plugins: [{ enabled: true }, { enabled: false }] },
    });
    await expect(
      storage.changePlugin("disable", "buzz.channels"),
    ).rejects.toThrow("Channels is required");
    expect(values.get("buzzodz.plugins.v1")).toBe(saved);
  }
  expect(
    await createPluginStorage(catalog).changePlugin("enable", "buzz.github"),
  ).toMatchObject({
    status: "ready",
    catalog: { plugins: [{ enabled: true }, { enabled: true }] },
  });
});

it.each(
  ["buzz.bestie", "buzz.reminders", "buzz.workflows"].flatMap((id) =>
    [true, false, undefined].map((saved) => ({ id, saved })),
  ),
)(
  "preserves saved $id=$saved and backfills legacy defaults",
  async ({ id, saved }) => {
    const flags = saved === undefined ? {} : { [id]: saved };
    const raw = JSON.stringify({ version: 3, enabled: flags });
    const values = new Map([["buzzodz.plugins.v1", raw]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const defaults = () => [
      ...catalog(),
      {
        source: "bundled" as const,
        revision: "bundled",
        previous: null,
        reloadable: false,
        error: null,
        manifest: { id, name: id, apiVersion: 1 as const },
        enabled: id === "buzz.bestie",
      },
    ];
    const expected = saved ?? id !== "buzz.bestie";
    const storage = createPluginStorage(defaults);
    expect(await storage.getCatalog()).toMatchObject({
      status: "ready",
      catalog: {
        plugins: [{ enabled: true }, { enabled: true }, { enabled: expected }],
      },
    });
    expect(JSON.parse(values.get("buzzodz.plugins.v1") ?? "").enabled[id]).toBe(
      expected,
    );
    const initialized = values.get("buzzodz.plugins.v1");
    await createPluginStorage(defaults).getCatalog();
    expect(values.get("buzzodz.plugins.v1")).toBe(initialized);
    await storage.changePlugin("disable", "buzz.github");
    expect(await createPluginStorage(defaults).getCatalog()).toMatchObject({
      status: "ready",
      catalog: {
        plugins: [{ enabled: true }, { enabled: false }, { enabled: expected }],
      },
    });
  },
);

const optionalCatalog = (): PluginInfo[] => [
  ...catalog(),
  ...["buzz.reminders", "buzz.workflows"].map((id) => bundledPlugin(id, false)),
  bundledPlugin("buzz.bestie"),
];
function browserStorage() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
      Object.defineProperty(storage, key, {
        configurable: true,
        enumerable: true,
      });
    }),
    removeItem: (key: string) => {
      values.delete(key);
      Reflect.deleteProperty(storage, key);
    },
  };
  vi.stubGlobal("localStorage", storage);
  return storage;
}
it.each([false, true])(
  "pins cold/existing browser profile (existing=%s) before later launches",
  async (existing) => {
    const storage = browserStorage();
    if (existing) storage.setItem(`buzz-client.v1:${"a".repeat(64)}`, "{}");
    for (let launch = 0; launch < 2; launch++) {
      expect(
        await createPluginStorage(optionalCatalog).getCatalog(),
      ).toMatchObject({
        status: "ready",
        catalog: {
          plugins: [
            { enabled: true },
            { enabled: true },
            { enabled: existing },
            { enabled: existing },
            { enabled: !existing },
          ],
        },
      });
      // The application writes client storage after its first plugin catalog.
      storage.setItem(`buzz-client.v1:${"a".repeat(64)}`, "{}");
    }
    await createPluginStorage(optionalCatalog).changePlugin(
      "disable",
      "buzz.workflows",
    );
    expect(
      await createPluginStorage(optionalCatalog).getCatalog(),
    ).toMatchObject({
      catalog: {
        plugins: [
          {},
          {},
          { enabled: existing },
          { enabled: false },
          { enabled: !existing },
        ],
      },
    });
  },
);
it("pins all known defaults across future releases and initializes new plugins once", async () => {
  const storage = browserStorage();
  await createPluginStorage(catalog).getCatalog();
  const changed = (): PluginInfo[] => [
    ...catalog().map((plugin) => ({ ...plugin, enabled: false })),
    bundledPlugin("example.new"),
  ];
  expect(await createPluginStorage(changed).getCatalog()).toMatchObject({
    catalog: {
      plugins: [{ enabled: true }, { enabled: true }, { enabled: true }],
    },
  });
  const saved = storage.getItem("buzzodz.plugins.v1");
  await createPluginStorage(() =>
    changed().map((p) => ({ ...p, enabled: false })),
  ).getCatalog();
  expect(storage.getItem("buzzodz.plugins.v1")).toBe(saved);
});
it("requires recovery for unreadable settings and resets to current defaults durably", async () => {
  const storage = browserStorage();
  storage.setItem(`buzz-client.v1:${"a".repeat(64)}`, "{}");
  storage.setItem("buzzodz.plugins.v1", "broken");
  const installation = createPluginStorage(optionalCatalog);
  expect(await installation.getCatalog()).toMatchObject({ status: "recovery" });
  expect(storage.getItem("buzzodz.plugins.v1")).toBe("broken");
  expect(await installation.recoverSettings()).toMatchObject({
    status: "ready",
    catalog: {
      plugins: [
        {},
        {},
        { enabled: false },
        { enabled: false },
        { enabled: true },
      ],
    },
  });
  expect(await createPluginStorage(optionalCatalog).getCatalog()).toMatchObject(
    {
      catalog: {
        plugins: [
          {},
          {},
          { enabled: false },
          { enabled: false },
          { enabled: true },
        ],
      },
    },
  );
  expect(
    Object.keys(storage).some(
      (key) =>
        key.startsWith("buzzodz.plugins.v1.backup.") &&
        storage.getItem(key) === "broken",
    ),
  ).toBe(true);
});
it("does not activate a catalog whose initial defaults could not be saved", async () => {
  const storage = browserStorage();
  storage.setItem.mockImplementation(() => {
    throw new Error("Quota exceeded");
  });
  expect(await createPluginStorage(optionalCatalog).getCatalog()).toMatchObject(
    {
      status: "recovery",
      reason: expect.stringContaining("Quota exceeded"),
    },
  );
  expect(storage.getItem("buzzodz.plugins.v1")).toBe(null);
});

it.each(["corrupt", "saved"])(
  "preserves %s settings when writing reset defaults fails",
  async (kind) => {
    const storage = browserStorage();
    const key = "buzzodz.plugins.v1";
    const original =
      kind === "corrupt"
        ? "broken"
        : JSON.stringify({
            version: 3,
            enabled: {
              "buzz.channels": true,
              "buzz.github": false,
              "buzz.reminders": false,
              "buzz.workflows": false,
              "buzz.bestie": false,
            },
          });
    storage.setItem(`buzz-client.v1:${"a".repeat(64)}`, "{}");
    storage.setItem(key, original);
    const write = storage.setItem.getMockImplementation();
    if (!write) throw new Error("Missing storage writer");
    storage.setItem.mockImplementation((name, value) => {
      if (name === key) throw new Error("Quota exceeded");
      write(name, value);
    });
    const installation = createPluginStorage(optionalCatalog);
    expect(await installation.recoverSettings()).toMatchObject({
      status: "recovery",
      reason: expect.stringContaining("Quota exceeded"),
    });
    expect(storage.getItem(key)).toBe(original);
    const reopened = await createPluginStorage(optionalCatalog).getCatalog();
    if (kind === "corrupt")
      expect(reopened).toMatchObject({ status: "recovery" });
    else
      expect(reopened).toMatchObject({
        status: "ready",
        catalog: {
          plugins: [
            {},
            { enabled: false },
            { enabled: false },
            { enabled: false },
            { enabled: false },
          ],
        },
      });
    storage.setItem.mockImplementation(write);
    expect(await installation.recoverSettings()).toMatchObject({
      status: "ready",
      catalog: {
        plugins: [
          {},
          { enabled: true },
          { enabled: false },
          { enabled: false },
          { enabled: true },
        ],
      },
    });
    expect(
      await createPluginStorage(optionalCatalog).getCatalog(),
    ).toMatchObject({
      status: "ready",
      catalog: {
        plugins: [
          {},
          {},
          { enabled: false },
          { enabled: false },
          { enabled: true },
        ],
      },
    });
  },
);

it("migrates the Agents switch once and ignores v1's", async () => {
  const agents = (): PluginInfo[] =>
    catalog()
      .slice(0, 1)
      .map((plugin) => ({
        ...plugin,
        manifest: { id: "buzz.agents", name: "Agents", apiVersion: 1 },
      }));
  const values = new Map([
    [
      "buzzodz.plugins.v1",
      JSON.stringify({ version: 2, enabled: { "buzz.agents": false } }),
    ],
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const installation = createPluginStorage(agents);
  expect(await installation.getCatalog()).toMatchObject({
    catalog: { plugins: [{ enabled: true }] },
  });
  expect(
    await installation.changePlugin("disable", "buzz.agents"),
  ).toMatchObject({ catalog: { plugins: [{ enabled: false }] } });
  expect(await createPluginStorage(agents).getCatalog()).toMatchObject({
    catalog: { plugins: [{ enabled: false }] },
  });
  expect(JSON.parse(values.get("buzzodz.plugins.v1") ?? "").version).toBe(3);
  expect(JSON.parse(values.get("buzzodz.plugins.v1") ?? "").enabled).toEqual({
    "buzz.agents": false,
  });
});

it.each([true, false])(
  "migrates Agents2=%s over the retired v1 override",
  async (enabled) => {
    const values = new Map([
      [
        "buzzodz.plugins.v1",
        JSON.stringify({
          version: 2,
          enabled: { "buzz.agents": !enabled, "buzz.agents2": enabled },
        }),
      ],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const agents = (): PluginInfo[] =>
      catalog()
        .slice(0, 1)
        .map((plugin) => ({
          ...plugin,
          manifest: { id: "buzz.agents", name: "Agents", apiVersion: 1 },
        }));
    for (let n = 0; n < 2; n++) {
      expect(await createPluginStorage(agents).getCatalog()).toMatchObject({
        catalog: { plugins: [{ enabled }] },
      });
    }
    expect(JSON.parse(values.get("buzzodz.plugins.v1") ?? "")).toEqual({
      version: 3,
      enabled: { "buzz.agents": enabled },
    });
  },
);
