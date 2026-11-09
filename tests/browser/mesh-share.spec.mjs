import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import config from "../fixtures/agent-control.vite.mjs";
import { watchPageErrors } from "./page-errors.mjs";

// Browser-only boundary: the real sharing page, model Select popup and narrow
// geometry. Synthetic IPC does not certify SDK serving or live agent replies.
test("sharing page presents the ladder and supports share/stop at desktop and narrow widths", async ({
  page,
}, testInfo) => {
  const server = await createServer({
    ...config,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const errors = watchPageErrors(page);
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mesh-share.html`,
    );
    const picker = page.getByRole("combobox", { name: "Model to share" });
    await expect(picker).toContainText("Auto");
    await expect(picker.locator("[title]")).toHaveAttribute(
      "title",
      "unsloth/Qwen3.8-27B-GGUF:Q4_K_M",
    );
    await picker.click();
    await expect(
      page.getByRole("option", { name: /Qwen 27B — recommended/ }),
    ).toBeVisible();
    await expect(page.getByRole("option", { name: /Gemma E4B/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /Qwen 9B/ })).toBeVisible();
    await page.getByRole("option", { name: /Qwen 27B/ }).click();
    await page
      .getByRole("switch", { name: "Share compute", exact: true })
      .click();
    await expect(
      page.getByRole("switch", { name: "Share compute", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      await page.evaluate(
        () =>
          window.meshShareFixture.calls.find(
            (call) => call.command === "mesh_compute_share",
          ).args.model,
      ),
    ).toBe("unsloth/Qwen3.8-27B-GGUF:Q4_K_M");
    for (const [width, mode] of [
      [1200, "light"],
      [390, "dark"],
    ]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate(
        (mode) =>
          document.documentElement.setAttribute("data-color-mode", mode),
        mode,
      );
      await expect(
        page.getByRole("switch", { name: "Share compute", exact: true }),
      ).toBeInViewport();
      // Assert the page's layout boundary and actual controls, not scrollWidth
      // of shared Select internals (WebKit reports overflow despite contained controls).
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBe(width);
      await expect
        .poll(() =>
          page
            .getByRole("region", { name: "Share compute", exact: true })
            .evaluate((region) => {
              const bounds = region.getBoundingClientRect();
              return [
                ...region.querySelectorAll(
                  'button, input:not([aria-hidden="true"]), dd',
                ),
              ]
                .filter((element) => element.getClientRects().length > 0)
                .filter((element) => {
                  const rect = element.getBoundingClientRect();
                  return rect.left < bounds.left || rect.right > bounds.right;
                })
                .map((element) => element.outerHTML);
            }),
        )
        .toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`sharing-${width}-${mode}.png`),
        fullPage: true,
      });
    }
    await page
      .getByRole("switch", { name: "Share compute", exact: true })
      .click();
    await expect(
      page.getByRole("switch", { name: "Share compute", exact: true }),
    ).toHaveAttribute("aria-checked", "false");
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});

// Browser-only boundary: real helper-page wiring, keyboard activation and responsive
// geometry. Creation uses a synthetic service; no host signing claim. Preset
// payloads, failures and duplicate prevention are covered by MeshHelpers.test.tsx.
test("main Shared compute helpers disclose authority and create a preset directly", async ({
  page,
}, testInfo) => {
  const server = await createServer({
    ...config,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const errors = watchPageErrors(page);
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mesh-share.html`,
    );
    const helpers = page.getByRole("region", { name: "Helpers", exact: true });
    for (const name of [
      "Media converter",
      "Thread summarizer",
      "Translator",
      "Custom agent",
    ])
      await expect(
        helpers.getByRole("button", { name: `Create ${name}`, exact: true }),
      ).toBeEnabled();
    await expect(
      helpers
        .getByText(
          /Agent: the serving member’s model directs shell and files on this machine, plus Buzz access; workspace ~\/\.buzz\. Tool output and core memory may be sent to that member\./,
        )
        .first(),
    ).toBeVisible();
    const create = helpers.getByRole("button", {
      name: "Create Translator",
      exact: true,
    });
    for (const width of [390, 1200])
      for (const mode of ["light", "dark"]) {
        await page.setViewportSize({ width, height: 950 });
        await page.evaluate((mode) => {
          document.documentElement.setAttribute("data-color-mode", mode);
          document.documentElement.style.fontSize = "20px";
        }, mode);
        await create.scrollIntoViewIfNeeded();
        await expect(create).toBeInViewport();
        expect(
          await helpers.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        ).toBe(true);
        await page.screenshot({
          path: testInfo.outputPath(`helper-${width}-${mode}.png`),
          fullPage: true,
        });
      }
    expect(await page.evaluate(() => window.meshHelperFixture.created)).toEqual(
      [],
    );
    await create.focus();
    await page.keyboard.press("Enter");
    await expect(helpers.getByRole("status")).toHaveText(
      "Translator created. Find it in Agents and add it to a conversation.",
    );
    expect(await page.evaluate(() => window.meshHelperFixture.created)).toEqual(
      [
        expect.objectContaining({
          name: "Translator",
          type: "buzz.mesh-compute/mesh",
          config: expect.objectContaining({
            preset: "translator",
            mode: "chat",
            workspace: "~/.buzz",
            prompt: expect.stringContaining("You translate messages"),
          }),
        }),
      ],
    );
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});
