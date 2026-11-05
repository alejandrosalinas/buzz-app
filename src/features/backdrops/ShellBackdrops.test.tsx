// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BackdropsService, type Backdrop } from "./service";
import { ShellBackdrops } from "./ShellBackdrops";

// One shared query, as a browser keeps it: the test flips the preference.
let plain = false;
const queries = new Set<string>();
const changes = new Set<() => void>();
beforeEach(() => {
  plain = false;
  vi.stubGlobal("matchMedia", (media: string) => ({
    media: queries.add(media) && media,
    get matches() {
      return plain;
    },
    addEventListener: (_: string, listener: () => void) =>
      changes.add(listener),
    removeEventListener: (_: string, listener: () => void) =>
      changes.delete(listener),
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  changes.clear();
  queries.clear();
});
const prefer = (next: boolean) =>
  act(() => {
    plain = next;
    for (const listener of changes) listener();
  });

function setup() {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const backdrops = new BackdropsService(root);
  const install = async (id: string, ...entries: Backdrop[]) => {
    const fiber = root
      .extend({ pluginOwner: { id, revision: "one" } })
      .plugin((ctx) => {
        for (const entry of entries) ctx.backdrops?.register(entry);
      });
    await act(() => fiber.await());
    return () => act(() => fiber.dispose());
  };
  const view = render(<ShellBackdrops backdrops={backdrops} />);
  return { root, install, view };
}

it("gives each backdrop its own layer in registration order and drops a failing one silently", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { root, install, view } = setup();
  await install("first.plugin", { id: "a", component: () => <i>first</i> });
  await install("broken.plugin", {
    id: "b",
    component: () => {
      throw new Error("paint failed");
    },
  });
  await install("third.plugin", { id: "c", component: () => <i>third</i> });

  const layers = view.container.querySelectorAll(
    ".shell-backdrop > .shell-backdrop-layer",
  );
  expect([...layers].map((layer) => layer.textContent)).toEqual([
    "first",
    "third",
  ]);
  expect(view.queryByRole("alert", { hidden: true })).toBeNull();
  await root.fiber.dispose();
});

it("unmounts every backdrop while the user prefers a plain shell and restores it after", async () => {
  const { root, install, view } = setup();
  const stopped = vi.fn();
  await install("first.plugin", {
    id: "a",
    component: function Glow() {
      useEffect(() => stopped, []);
      return <canvas />;
    },
  });
  expect(view.container.querySelector(".shell-backdrop canvas")).not.toBeNull();

  expect([...queries]).toEqual([
    "(prefers-reduced-motion: reduce), (prefers-reduced-transparency: reduce), (forced-colors: active)",
  ]);
  await prefer(true);
  expect(view.container.innerHTML).toBe("");
  expect(stopped).toHaveBeenCalledTimes(1);
  await prefer(false);
  expect(view.container.querySelector(".shell-backdrop canvas")).not.toBeNull();
  await root.fiber.dispose();
});
