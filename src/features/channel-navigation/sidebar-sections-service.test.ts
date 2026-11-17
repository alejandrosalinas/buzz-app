import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarSectionsService } from "./sidebar-sections-service";

const rows = {
  snapshot: () => [{ id: "row", label: "Row" }],
  subscribe: () => () => {},
};
const section = {
  version: 1 as const,
  id: "work",
  title: "Work",
  icon: "W",
  rows,
  select: () => ({ version: 1 as const, kind: "home" as const }),
};

function rootContext() {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  return root;
}

afterEach(() => vi.restoreAllMocks());

it("registers a versioned section under its owner and disposes it with the plugin", async () => {
  const root = rootContext();
  const registry = new SidebarSectionsService(root);
  const scope = root.extend({
    pluginOwner: { id: "example.plugin", revision: "one" },
  });
  const fiber = scope.plugin((ctx) => ctx.sidebarSections?.register(section));
  await fiber.await();

  expect(registry.snapshot()).toMatchObject([
    {
      ...section,
      key: "example.plugin/work",
      pluginId: "example.plugin",
      revision: "one",
    },
  ]);
  await fiber.dispose();
  expect(registry.snapshot()).toEqual([]);
  await root.fiber.dispose();
});

it("ignores an unsupported contribution version without failing plugin activation", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const root = rootContext();
  const registry = new SidebarSectionsService(root);
  const applied = vi.fn();
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "one" } })
    .plugin((ctx) => {
      ctx.reflect.get("sidebarSections")?.register({
        ...section,
        version: 2,
      } as never);
      applied();
    });

  await fiber.await();
  expect(registry.snapshot()).toEqual([]);
  expect(applied).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledOnce();
  await root.fiber.dispose();
});

it("lets a plugin use an older host that does not provide sidebar sections", async () => {
  const root = new Context();
  const registerPage = vi.fn();
  root.provide("pages", { register: registerPage } as never);
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "one" } })
    .plugin((ctx) => {
      ctx.reflect.get("sidebarSections")?.register(section);
      ctx.pages.register({
        id: "page",
        title: "Page",
        component: () => null,
      });
    });

  await fiber.await();
  expect(registerPage).toHaveBeenCalledWith(
    expect.objectContaining({ id: "page", title: "Page" }),
  );
  await root.fiber.dispose();
});

it("limits preview sources to bundled owners and removes them on disposal", async () => {
  const { bundledOwner } = await import("../../plugins/provenance");
  const root = rootContext();
  const registry = new SidebarSectionsService(root);
  const source = {
    version: 2 as const,
    id: "inventory",
    scope: "team" as const,
    context: "buzz.channels/messages",
    component: () => null,
  };
  const unbundled = root.extend({
    pluginOwner: { id: "example.plugin", revision: "one" },
  });
  expect(() => unbundled.sidebarSections?.registerSource?.(source)).toThrow(
    /bundled/,
  );
  // Claiming the bundled plugin's public name is not provenance.
  expect(() =>
    root
      .extend({ pluginOwner: { id: "buzz.channels", revision: "bundled" } })
      .sidebarSections?.registerSource?.(source),
  ).toThrow(/bundled/);
  expect(registry.sourceSnapshot()).toEqual([]);
  const fiber = root
    .extend({
      pluginOwner: bundledOwner({ id: "buzz.channels", revision: "bundled" }),
    })
    .plugin((ctx) => ctx.sidebarSections?.registerSource?.(source));
  await fiber.await();
  expect(registry.sourceSnapshot()).toMatchObject([
    { key: "buzz.channels/inventory", pluginId: "buzz.channels" },
  ]);
  expect(registry.snapshot()).toEqual([]);
  await fiber.dispose();
  expect(registry.sourceSnapshot()).toEqual([]);
  await root.fiber.dispose();
});

it("owns neutral sidebar contexts as bundled contributions and removes them on disposal", async () => {
  const { bundledOwner } = await import("../../plugins/provenance");
  const root = rootContext();
  const registry = new SidebarSectionsService(root);
  const context = {
    id: "navigation",
    matches: () => true,
    component: () => null,
  };
  expect(() =>
    root
      .extend({ pluginOwner: { id: "example.plugin", revision: "one" } })
      .sidebarSections?.registerContext?.(context),
  ).toThrow(/bundled/);
  const fiber = root
    .extend({
      pluginOwner: bundledOwner({ id: "example.navigation", revision: "one" }),
    })
    .plugin((ctx) => {
      ctx.sidebarSections?.registerContext?.(context);
    });
  await fiber.await();
  expect(registry.contextSnapshot()).toEqual([
    expect.objectContaining({
      key: "example.navigation/navigation",
      component: context.component,
    }),
  ]);
  await fiber.dispose();
  expect(registry.contextSnapshot()).toEqual([]);
  await root.fiber.dispose();
});
