import { expect, test } from "./playwright-test.mjs";
import { build, preview } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

let server;
let directory;
let url;

// Immutable build/server per worker; each test owns its page and fixture state.
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  directory = await mkdtemp(join(tmpdir(), "buzz-goose-model-row-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    build: {
      rollupOptions: {
        input: join(root, "tests/browser/goose-model-row.html"),
      },
      outDir: join(directory, "dist"),
      emptyOutDir: true,
      target: "esnext",
    },
  };
  await build(config);
  server = await preview({
    ...config,
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/goose-model-row.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

// Layout: a long model name must truncate inside its settings row, keeping its
// Default source and a one-line title, beside the title and when a narrow pane
// stacks it below.
test("a long goose model name stays inside its Settings row", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  for (const width of [520, 320]) {
    await page.goto(`${url}?width=${width}`);
    const model = page.getByRole("button", {
      name: /^Model: Claude Sonnet 5\.5 Extended Context Thinking Preview 2026\.10/,
    });
    await expect(model).toBeEnabled();
    const geometry = await model.evaluate((button) => {
      const rowElement = button.closest(".buzz-preference-row");
      const row = rowElement.getBoundingClientRect();
      const title = rowElement.querySelector(".buzz-preference-row-label");
      const box = button.getBoundingClientRect();
      const value = button.querySelector(".buzz-select-value");
      const suffix = button
        .querySelector(".buzz-select-value-suffix")
        ?.getBoundingClientRect();
      return {
        inside: box.left >= row.left - 0.5 && box.right <= row.right + 0.5,
        truncated: value.scrollWidth > value.clientWidth,
        // Only the name truncates; the Default source stays in view.
        suffixShown:
          !!suffix &&
          suffix.width > 0 &&
          suffix.left >= value.getBoundingClientRect().right - 0.5 &&
          suffix.right <= box.right + 0.5,
        // The control yields width before the title wraps inside its word.
        titleLines: Math.round(
          title.getBoundingClientRect().height /
            Number.parseFloat(getComputedStyle(title).lineHeight),
        ),
      };
    });
    expect(geometry, `at ${width}px`).toEqual({
      inside: true,
      truncated: true,
      suffixShown: true,
      titleLines: 1,
    });
  }
  expect(errors.unexplained()).toEqual([]);
});

// Layout: Create agent nests the picker one level deeper, so its Model title
// must still keep its word instead of wrapping one letter per line.
test("a long goose model name leaves Create agent's Model title whole", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto(`${url}?width=520&surface=create`);
  const model = page.getByRole("button", {
    name: /^Goose model: Claude Sonnet 5\.5 Extended Context Thinking Preview 2026\.10/,
  });
  await expect(model).toBeEnabled();
  const geometry = await model.evaluate((button) => {
    const rowElement = button.closest(".buzz-preference-row");
    const row = rowElement.getBoundingClientRect();
    const title = rowElement.querySelector(".buzz-preference-row-label");
    const box = button.getBoundingClientRect();
    const value = button.querySelector(".buzz-select-value");
    return {
      inside: box.left >= row.left - 0.5 && box.right <= row.right + 0.5,
      truncated: value.scrollWidth > value.clientWidth,
      titleLines: Math.round(
        title.getBoundingClientRect().height /
          Number.parseFloat(getComputedStyle(title).lineHeight),
      ),
    };
  });
  expect(geometry).toEqual({ inside: true, truncated: true, titleLines: 1 });
  expect(errors.unexplained()).toEqual([]);
});

// Layout: the thinking level takes only its own width, so a short model name
// shows whole beside it and a long inherited one truncates before its Default
// source, with neither leaving a gap before the caret.
test("Create agent's model picker gives the name what the level leaves", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  for (const [model, name, truncated] of [
    ["short", /^Goose model: Claude Opus 5\.5 · Default, Automatic$/, false],
    [
      "long",
      /^Goose model: Claude Sonnet 5\.5 Extended Context Thinking Preview 2026\.10 · Default, Automatic$/,
      true,
    ],
  ]) {
    await page.goto(`${url}?width=520&surface=create&thinking&model=${model}`);
    const button = page.getByRole("button", { name });
    await expect(button).toBeEnabled();
    const geometry = await button.evaluate((trigger) => {
      const rect = (selector) =>
        trigger.querySelector(selector).getBoundingClientRect();
      const value = trigger.querySelector(".buzz-select-value");
      const suffix = rect(".buzz-select-value-suffix");
      const effort = rect(".buzz-select-value-suffix + span");
      const caret = [...trigger.querySelectorAll("svg")]
        .at(-1)
        .getBoundingClientRect();
      const gap = Number.parseFloat(
        getComputedStyle(
          trigger.querySelector(".buzz-select-value-suffix + span"),
        ).marginInlineStart,
      );
      return {
        truncated: value.scrollWidth > value.clientWidth,
        // Default follows the name, then the level, each one gap apart.
        suffixAttached:
          Math.abs(suffix.left - value.getBoundingClientRect().right) < 1,
        effortAfterSuffix: Math.abs(effort.left - suffix.right - gap) < 1,
        effortWhole: effort.width > 0 && effort.right <= caret.left + 0.5,
        // No leftover space between the level and the caret.
        caretFollows: caret.left - effort.right <= gap + 0.5,
      };
    });
    expect(geometry, model).toEqual({
      truncated,
      suffixAttached: true,
      effortAfterSuffix: true,
      effortWhole: true,
      caretFollows: true,
    });
  }
  expect(errors.unexplained()).toEqual([]);
});
