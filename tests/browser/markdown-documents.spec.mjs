import { expect, test } from "./playwright-test.mjs";
import { build, preview } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

const SHOTS = fileURLToPath(
  new URL("../../test-results/markdown-documents/", import.meta.url),
);

let server;
let directory;
let url;

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  directory = await mkdtemp(join(tmpdir(), "buzz-markdown-documents-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    build: {
      rollupOptions: {
        input: join(root, "tests/browser/markdown-documents.html"),
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
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/markdown-documents.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

const role = (page, name) =>
  page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.fontSize = `var(--text-${name})`;
    document.body.append(probe);
    const size = getComputedStyle(probe).fontSize;
    probe.remove();
    return size;
  }, name);

// Each screen's roles for the sample's `#`, `##` and `###` headings; `null`:
// the screen drops it.
const ROLES = {
  canvas: ["title", "heading", "body-lg"],
  notes: ["title", "heading", "body-lg"],
  repo: ["title", "heading", "body-lg"],
  github: ["title", "heading", "body-lg"],
  memory: ["heading", "body-lg", "label"],
  transcript: ["heading", "body-lg", "label"],
  // It drops the title and nests sections under the pane's own heading.
  "plugin-readme": [null, "label", "label"],
  attention: ["label", "label-sm", "label-sm"],
};
// Screens whose code blocks offer copy.
const COPY = [
  "canvas",
  "notes",
  "repo",
  "memory",
  "transcript",
  "plugin-readme",
];
const CODE = "const value = 1;";
// The fixture's long transcript reply, as its copy action writes it.
const LONG_CODE_TEXT = Array.from(
  { length: 60 },
  (_, line) => `${line} ${"x".repeat(160)}`,
).join("\n");

/** Opens the memory and transcript disclosures that hold the sample. */
async function expand(page) {
  await page
    .locator('[data-screen="memory"]')
    .getByRole("button", { name: "core" })
    .click();
  await page
    .locator('[data-screen="plugin-readme"]')
    .getByRole("button", { name: "View more" })
    .click();
  const replies = page.locator(
    '[data-screen="transcript"] details:not([open]) > summary',
  );
  while ((await replies.count()) > 0) await replies.first().click();
}

// Layout and interaction: jsdom resolves neither type roles nor hover.
test("document screens keep their roles, elements and code actions in their hosts", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Screenshots are Chromium's.");
  const errors = watchPageErrors(page);
  await page.addInitScript(() => {
    window.copied = [];
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text) => {
          window.copied.push(text);
        },
      },
    });
  });
  await mkdir(SHOTS, { recursive: true });
  for (const mode of ["light", "dark"])
    for (const width of [360, 1100])
      for (const scale of ["1", "1.5"]) {
        await page.setViewportSize({ width: width + 32, height: 900 });
        await page.goto(`${url}?mode=${mode}&width=${width}&scale=${scale}`);
        await page.evaluate(() => document.fonts.ready);
        await expand(page);
        // Copy toasts would stack over the next screen's code.
        await page.addStyleTag({
          content: '[aria-label="App notifications"] { pointer-events: none; }',
        });
        const label = `${mode} ${width}px ×${scale}`;
        expect(
          await page.evaluate(() =>
            [...document.fonts].some(
              (face) =>
                face.family.includes("Inter") && face.status === "loaded",
            ),
          ),
          label,
        ).toBe(true);
        for (const [screen, roles] of Object.entries(ROLES)) {
          const section = page.locator(`[data-screen="${screen}"]`);
          const where = `${screen} ${label}`;
          await expect(section.getByText("Section").first()).toBeVisible();
          const read = await section.evaluate((section) => {
            const find = (text) =>
              [...section.querySelectorAll("h1, h2, h3, h4, h5, h6")].find(
                (node) => node.textContent === text,
              );
            const body = find("Section").parentElement;
            const style = (node, name) =>
              node ? getComputedStyle(node).getPropertyValue(name) : null;
            return {
              headings: [
                style(find("Title"), "font-size"),
                style(find("Section"), "font-size"),
                style(find("Topic"), "font-size"),
              ],
              elements: ["del", "blockquote", "hr", "table", "ol", "pre"].every(
                (tag) => body.querySelector(tag),
              ),
              checkbox: Boolean(body.querySelector('input[type="checkbox"]')),
              nested: style(body.querySelector("ul ul"), "list-style-type"),
              frame: style(body.querySelector("pre"), "border-top-width"),
              chip: style(
                body.querySelector(":not(pre) > code"),
                "background-color",
              ),
              header: style(body.querySelector("th"), "background-color"),
              display: getComputedStyle(body).display,
            };
          });
          for (const [index, name] of roles.entries())
            expect(
              read.headings[index],
              `${where} ${"#".repeat(index + 1)}`,
            ).toBe(name ? await role(page, name) : null);
          expect(read, where).toMatchObject({
            elements: true,
            checkbox: true,
            frame: "1px",
          });
          expect(read.chip, where).not.toBe("rgba(0, 0, 0, 0)");
          expect(read.header, where).not.toBe("rgba(0, 0, 0, 0)");
          if (screen === "attention") expect(read.display, where).toBe("grid");
          if (["canvas", "notes", "repo", "github"].includes(screen))
            expect(read.nested, where).toBe("circle");
        }
        // Screenshots come before any copy, so no notification covers them.
        await expect(page.locator(".buzz-toast")).toHaveCount(0);
        for (const screen of Object.keys(ROLES))
          await page.locator(`[data-screen="${screen}"]`).screenshot({
            path: `${SHOTS}${screen}-${mode}-${width}-${scale}.png`,
          });
        // Copy: the actions show on hover and on keyboard focus, and both a
        // click and the keyboard copy the code exactly.
        for (const screen of COPY) {
          const where = `${screen} ${label}`;
          const pre = page
            .locator(`[data-screen="${screen}"] pre`)
            .filter({ hasText: CODE });
          const copy = pre.getByRole("button", { name: "Copy code block" });
          const actions = copy.locator("..");
          await page.evaluate(() => {
            window.copied = [];
          });
          await pre.scrollIntoViewIfNeeded();
          await pre.hover();
          await expect(actions, where).toHaveCSS("opacity", "1");
          await copy.click();
          await page.mouse.move(0, 0);
          await copy.blur();
          await expect(actions, where).toHaveCSS("opacity", "0");
          await copy.focus();
          await expect(actions, where).toHaveCSS("opacity", "1");
          await page.keyboard.press("Enter");
          await expect
            .poll(() => page.evaluate(() => window.copied), { message: where })
            .toEqual([CODE, CODE]);
        }
        // In the real Canvas editor, a line that cannot wrap scrolls inside its
        // block; the view panel and its article stay at the host's width.
        const host = await page
          .locator('[data-screen="canvas-host"]')
          .evaluate((section) => {
            const code = section.querySelector("pre code");
            const width = (node) => node.getBoundingClientRect().width;
            return {
              host: width(section),
              panel: width(section.querySelector('[role="tabpanel"]')),
              article: width(code.closest("pre").parentElement),
              contained: section.scrollWidth <= section.clientWidth,
              client: code.clientWidth,
              scroll: code.scrollWidth,
            };
          });
        expect(host.panel, label).toBeLessThanOrEqual(host.host);
        expect(host.article, label).toBeLessThanOrEqual(host.host);
        expect(host.contained, label).toBe(true);
        expect(host.scroll, label).toBeGreaterThan(host.client);
        // A rejected document's source still wraps.
        const source = page.locator('[data-screen="canvas-source"] pre code');
        await expect(source).toHaveCSS("white-space", "pre-wrap");
        expect(
          await source.evaluate((code) => code.scrollWidth <= code.clientWidth),
          label,
        ).toBe(true);
        // A long transcript reply wraps, scrolls under a 24rem block (frame
        // included), and keeps its copy action pinned while it scrolls.
        const longPre = page
          .locator('[data-screen="transcript"] pre')
          .filter({ hasText: "59 xxx" });
        const long = await longPre.evaluate((pre) => {
          const code = pre.querySelector("code");
          const button = pre.querySelector("[aria-label='Copy code block']");
          const offset = () =>
            button.getBoundingClientRect().top -
            pre.getBoundingClientRect().top;
          const before = offset();
          // Scroll whatever scrolls; only the code should.
          code.scrollTop = code.scrollHeight;
          pre.scrollTop = pre.scrollHeight;
          const preScrolled = pre.scrollTop > 0;
          return {
            outer: pre.getBoundingClientRect().height,
            rem: Number.parseFloat(
              getComputedStyle(document.documentElement).fontSize,
            ),
            wraps: code.scrollWidth <= code.clientWidth,
            scrolled: code.scrollTop > 0,
            pinned: offset() === before,
            preScrolled,
          };
        });
        expect(long, label).toMatchObject({
          outer: 24 * long.rem,
          wraps: true,
          scrolled: true,
          pinned: true,
          preScrolled: false,
        });
        await page.evaluate(() => {
          window.copied = [];
        });
        await longPre.hover();
        await longPre.getByRole("button", { name: "Copy code block" }).click();
        await expect
          .poll(() => page.evaluate(() => window.copied), { message: label })
          .toEqual([LONG_CODE_TEXT]);
      }
  expect(errors.unexplained()).toEqual([]);
});
