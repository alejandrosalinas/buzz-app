import { Context } from "@deepseek-ai/cordis";
import { expect, it } from "vitest";
import { BackdropsService } from "./service";

function rootContext() {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  return root;
}

it("registers a backdrop under its owner and removes it with the plugin", async () => {
  const root = rootContext();
  const backdrops = new BackdropsService(root);
  const component = () => null;
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "one" } })
    .plugin((ctx) =>
      ctx.reflect.get("backdrops")?.register({ id: "glow", component }),
    );
  await fiber.await();
  expect(backdrops.snapshot()).toMatchObject([
    {
      id: "glow",
      component,
      key: "example.plugin/glow",
      pluginId: "example.plugin",
    },
  ]);
  await fiber.dispose();
  expect(backdrops.snapshot()).toEqual([]);
  await root.fiber.dispose();
});

it("rejects a backdrop without an id or component", async () => {
  const root = rootContext();
  const backdrops = new BackdropsService(root);
  const scope = root.extend({
    pluginOwner: { id: "example.plugin", revision: "one" },
  });
  for (const bad of [
    { id: "", component: () => null },
    { id: "Glow", component: () => null },
    { id: "glow", component: "div" },
  ])
    expect(() => scope.backdrops?.register(bad as never)).toThrow(
      "A backdrop needs an id and a React component function",
    );
  expect(backdrops.snapshot()).toEqual([]);
  await root.fiber.dispose();
});
