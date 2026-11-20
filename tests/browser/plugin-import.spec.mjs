import { documentPlugin } from "./document-plugin.mjs";
import { pluginAction } from "./plugin-settings.mjs";
import {
  activate,
  chooseColorMode,
  closeSettings,
  openPage,
  openSettings,
  pageChoice,
  pageChoices,
  selectSettingsSection,
  settingsDialog,
  settleDialogMotion,
} from "./navigation.mjs";
import { readFile } from "node:fs/promises";
import { test, expect } from "./fixture.mjs";
import { animationsSettled } from "./animations.mjs";

test.use({ historyCounts: { alpha: 0, beta: 0 } });
const button = (page, name) => page.getByRole("button", { name, exact: true });
// A closed plugin dialog returns to Settings, the only remaining modal.
async function expectOnlySettings(page) {
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(settingsDialog(page)).toBeVisible();
}
async function openPlugins(page, origin) {
  await page.goto(origin);
  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
}
// Native IPC is the boundary fixture; Settings -> manager -> platform adapter are production.
async function nativeImports(
  page,
  samples = [],
  previewOptions = {},
  links = [],
  hold = false,
  persistInstalled = false,
) {
  const input = { samples, previewOptions, links, hold, persistInstalled };
  await page.addInitScript((input) => {
    const { samples, previewOptions, links, hold, persistInstalled } = input;
    window.isTauri = true;
    window.importCalls = [];
    window.importDelay = hold;
    const saved = persistInstalled
      ? JSON.parse(
          sessionStorage.getItem("fixture.installed-plugins") ?? "null",
        )
      : null;
    const plugins =
      saved ??
      ["channels", "github", "bestie", "repos", "workflows"].map((name) => ({
        manifest: { id: `buzz.${name}`, name, apiVersion: 1 },
        source: "bundled",
        enabled: true,
        revision: "bundled",
        previous: null,
        reloadable: false,
        error: null,
      }));
    // A journey can start with external plugins already installed.
    plugins.push(...(window.installedPlugins ?? []));
    const ready = () => {
      if (persistInstalled)
        sessionStorage.setItem(
          "fixture.installed-plugins",
          JSON.stringify(plugins),
        );
      return {
        status: "ready",
        externalPluginsPaused: false,
        // Real IPC serializes a new snapshot; don't let later fixture writes mutate
        // the manager's previously accepted catalog and bypass reconciliation.
        catalog: {
          profile: "fixture",
          location: "isolated IPC",
          plugins: structuredClone(plugins),
        },
        ...(window.managedPolicy && {
          managed: {
            ...window.managedPolicy,
            plugins: window.managedPolicy.plugins.map((entry) => {
              const plugin = plugins.find(
                (plugin) => plugin.manifest.id === entry.id,
              );
              return {
                ...entry,
                state: !plugin
                  ? "missing"
                  : plugin.revision === entry.sha256
                    ? "current"
                    : plugin.updateSource?.url
                      ? "outdated"
                      : "other",
              };
            }),
          },
        }),
      };
    };
    let importSource = null;
    let pendingPreview = null;
    let importLocked = false;
    let previewSequence = 0;
    const preview = {
      source: "https://github.com/example/plugins",
      commit: "a".repeat(40),
      warnings: ["broken: Missing file: broken/plugin.js"],
      ...previewOptions,
      candidates: samples.length
        ? samples
        : ["one", "two"].map((name) => ({
            path: `plugins/${name}/dist`,
            manifest: {
              id: `example.${name}`,
              name: `Example ${name}`,
              apiVersion: 1,
            },
            revision: name,
          })),
    };
    // Match Tauri core's callback IDs and Channel serialization, not a fake
    // Channel class: constructing the production bridge must cross real JS IPC.
    let nextCallback = 0;
    const callbacks = new Map();
    window.__TAURI_INTERNALS__ = {
      transformCallback(callback, once = false) {
        const id = ++nextCallback;
        callbacks.set(id, (value) => {
          if (once) callbacks.delete(id);
          callback?.(value);
        });
        return id;
      },
      unregisterCallback(id) {
        callbacks.delete(id);
      },
      invoke: async (command, args) => {
        window.importCalls.push({ command, args });
        if (command === "deep_link_take") return links.splice(0);
        if (command === "deep_link_watch") {
          const wireChannel = args.onEvent.toJSON();
          if (
            wireChannel !== `__CHANNEL__:${args.onEvent.id}` ||
            !callbacks.has(args.onEvent.id)
          )
            throw new Error("Invalid deep-link channel");
          let index = 0;
          window.deliverPluginLink = (url) => {
            links.push(url);
            callbacks.get(args.onEvent.id)({
              index: index++,
              message: { pending: links.length },
            });
          };
          return;
        }
        if (command === "plugin_catalog") return ready();
        if (command === "plugin_update_check") {
          const plugin = plugins.find(
            (plugin) => plugin.manifest.id === args.id,
          );
          const candidate = preview.candidates.find(
            (candidate) =>
              candidate.manifest.id === args.id &&
              candidate.path === plugin?.updateSource?.path,
          );
          if (!candidate)
            throw new Error("Saved source no longer contains this plugin");
          return {
            revision: window.importCategory
              ? `${candidate.path}-${window.importCategory}`
              : candidate.revision,
            publisher: candidate.publisher ?? null,
          };
        }
        if (command === "plugin_import_git" && args?.checkOnly) {
          // A journey can hold an update check to observe it in progress.
          await window.heldGitCheck;
          if (window.gitCheckError) throw window.gitCheckError;
          const result = structuredClone(preview);
          if (window.importCategory)
            for (const candidate of result.candidates)
              candidate.revision = `${candidate.path}-${window.importCategory}`;
          return result;
        }
        if (
          command === "plugin_update_preview" ||
          command === "plugin_import_folder" ||
          command === "plugin_import_git" ||
          command === "plugin_import_url"
        ) {
          if (importLocked) throw new Error("Another import is in progress");
          importLocked = true;
          pendingPreview = null;
          try {
            if (window.importDelay)
              await new Promise((resolve) => {
                window.resolveImport = resolve;
              });
            if (window.importAcquisitionError)
              throw new Error(window.importAcquisitionError);
            if (args?.repository === "bad")
              throw new Error("Repository unavailable");
            if (
              command === "plugin_import_url" &&
              args.sha256 !== window.artifactSha256
            )
              throw new Error(
                `The downloaded plugin has SHA-256 ${window.artifactSha256}, not the expected ${args.sha256}`,
              );
            importSource =
              command === "plugin_import_url"
                ? { url: args.url, sha256: args.sha256 }
                : command === "plugin_import_git"
                  ? { repository: args.repository, reference: args.reference }
                  : args?.upload
                    ? null
                    : {
                        root:
                          command === "plugin_update_preview"
                            ? plugins.find(
                                (plugin) => plugin.manifest.id === args.id,
                              )?.updateSource?.root
                            : "/fixture/plugins",
                      };
            if (window.importCategory)
              for (const candidate of preview.candidates) {
                candidate.revision = `${candidate.path}-${window.importCategory}`;
                candidate.manifest.discovery = {
                  category: window.importCategory,
                };
              }

            pendingPreview = {
              ...structuredClone(preview),
              ...(command === "plugin_import_url" && {
                source: args.url,
                commit: null,
              }),
              token: `preview-${++previewSequence}`,
            };
            return structuredClone(pendingPreview);
          } finally {
            importLocked = false;
          }
        }
        if (command === "plugin_import_discard") {
          if (importLocked) throw new Error("Another import is in progress");
          if (pendingPreview?.token === args.token) pendingPreview = null;
          return;
        }
        // Agent storage starts empty; the app saves agent state there.
        if (command === "app_agent_state_load") return {};
        if (command === "app_agent_state_set") return;
        if (command === "plugin_import_install") {
          if (importLocked) throw new Error("Another import is in progress");
          if (!pendingPreview || pendingPreview.token !== args.token)
            throw new Error("This import preview expired");
          importLocked = true;
          try {
            if (window.importInstallError) {
              await new Promise((resolve) => {
                window.rejectInstall = resolve;
              });
              throw new Error(window.importInstallError);
            }
            const candidate = pendingPreview.candidates.find(
              (p) => p.path === args.path,
            );
            const existing = plugins.find(
              (p) => p.manifest.id === candidate.manifest.id,
            );
            if (existing) {
              existing.manifest = structuredClone(candidate.manifest);
              existing.previous = existing.revision;
              existing.revision = candidate.revision;
              existing.updateSource = importSource?.url
                ? importSource
                : importSource
                  ? { ...importSource, path: candidate.path }
                  : null;
            } else
              plugins.push({
                ...candidate,
                source: "external",
                enabled: false,
                previous: null,
                reloadable: true,
                updateSource: importSource?.url
                  ? importSource
                  : importSource
                    ? { ...importSource, path: candidate.path }
                    : null,
                error: null,
              });
            return ready();
          } finally {
            importLocked = false;
          }
        }
        if (command === "plugin_reload") {
          const plugin = plugins.find((p) => p.manifest.id === args.id);
          plugin.previous = plugin.revision;
          plugin.revision = `${plugin.revision}-reload`;
          plugin.reloadable = true;
          return ready();
        }
        if (command === "plugin_change") {
          if (args.action === "remove")
            plugins.splice(
              plugins.findIndex((p) => p.manifest.id === args.id),
              1,
            );
          else
            plugins.find((p) => p.manifest.id === args.id).enabled =
              args.action === "enable";
          return ready();
        }
        if (command === "plugin_module")
          return (
            samples.find((sample) => sample.manifest.id === args.id)?.code ??
            "export function apply() {}"
          );
        if (command === "credential_pairing_communities") return;
        throw new Error(`Unexpected command ${command}`);
      },
    };
  }, input);
}

// Scrolling must not change the pixels behind the fixed review title.
test("scrolling a long update review keeps its heading readable", async ({
  page,
  app,
}, info) => {
  await page.setViewportSize({ width: 1230, height: 820 });
  await page.clock.install();
  await nativeImports(
    page,
    [
      {
        path: "dist",
        revision: "one",
        manifest: {
          id: "example.counter",
          name: "Counter playground",
          apiVersion: 1,
        },
      },
    ],
    {
      warnings: Array.from(
        { length: 32 },
        (_, i) =>
          `dist: Optional asset ${i + 1} could not be read from the plugin folder`,
      ),
    },
  );
  await openPlugins(page, app.origin);
  await button(page, "Add").click();
  await page.getByLabel("Git or GitHub repository").fill("example/plugins");
  await button(page, "Find plugins").click();
  await button(page, "Install plugin").click();
  await expectOnlySettings(page);
  await button(page, "View Counter playground details").click();
  await page.evaluate(() => {
    window.importCategory = "productivity";
  });
  await button(page, "Check for updates").click();
  await button(page, "Update").click();
  const review = page.getByRole("dialog", {
    name: "Update Counter playground",
    exact: true,
  });
  await expect(
    review
      .getByRole("region", { name: "Skipped folders" })
      .getByRole("listitem"),
  ).toHaveCount(32);
  await settleDialogMotion(review);
  const heading = review.locator(".buzz-dialog-heading");
  const before = await heading.screenshot();
  await review.screenshot({
    path: info.outputPath("update-review-before.png"),
  });
  await review.hover();
  await page.mouse.wheel(0, 210);
  await expect
    .poll(() => review.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(100);
  const after = await heading.screenshot();
  await review.screenshot({
    path: info.outputPath("update-review-scrolled.png"),
  });
  expect(after.equals(before)).toBe(true);
  const material = review.locator(
    ".buzz-dialog-header > .buzz-dialog-bar-material",
  );
  const bounds = await material.boundingBox();
  expect(bounds).not.toBeNull();
  const clip = {
    x: bounds.x + 4,
    y: bounds.y + bounds.height - 3,
    width: 20,
    height: 2,
  };
  const body = review.locator(":scope > .buzz-dialog-content");
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await body.evaluate((node) => {
      node.style.background = "rgb(255, 0, 0)";
    });
    const red = await page.screenshot({ clip });
    await body.evaluate((node) => {
      node.style.background = "rgb(0, 0, 255)";
    });
    const blue = await page.screenshot({ clip });
    expect(
      blue.equals(red),
      `${colorScheme} header gutter fades into its body`,
    ).toBe(false);
    await body.evaluate((node) => {
      node.style.removeProperty("background");
    });
  }
  await review.getByRole("button", { name: "Close", exact: true }).click();
  await expect(review).toHaveCount(0);
});

test("browser omits native import acquisition controls", async ({
  page,
  app,
}) => {
  await openPlugins(page, app.origin);
  await expect(
    page.getByText(
      "Open the desktop app to load plugins from a folder or Git repository.",
    ),
  ).toHaveCount(0);
  await expect(button(page, "Add")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Add a plugin" })).toHaveCount(
    0,
  );
});

// Real font metrics, text wrapping and icon geometry are not observable in jsdom.
test("Settings controls scale together and keep enlarged labels reachable", async ({
  page,
  app,
}, info) => {
  await nativeImports(page);
  await openPlugins(page, app.origin);
  const checkButtons = async (section, scale) => {
    await expect
      .poll(() =>
        section.evaluate((root, scale) => {
          const failures = [];
          const bounds = root.getBoundingClientRect();
          for (const label of root.querySelectorAll(
            ".buzz-choice-label, .buzz-field-label, .buzz-content-header-title",
          )) {
            // Theme choices have intentionally clipped spoken labels; measure
            // their visible thumbnails instead of the unclipped text range.
            const thumbnail = label.querySelector(".buzz-theme-thumbnail");
            if (thumbnail) {
              const box = thumbnail.getBoundingClientRect();
              if (box.left < bounds.left || box.right > bounds.right)
                failures.push("Theme preview overflows section");
              continue;
            }
            if (label.classList.contains("sr-only")) continue;
            // Measure visible text only; sr-only spans are clipped by design.
            const walker = document.createTreeWalker(
              label,
              NodeFilter.SHOW_TEXT,
            );
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              if (node.parentElement.closest(".sr-only")) continue;
              const text = document.createRange();
              text.selectNodeContents(node);
              for (const line of text.getClientRects()) {
                if (line.left < bounds.left || line.right > bounds.right)
                  failures.push(
                    `${label.textContent}: setting label overflows section`,
                  );
              }
            }
          }
          for (const button of root.querySelectorAll("button.buzz-button")) {
            const box = button.getBoundingClientRect();
            if (button.closest(".buzz-empty-state")) {
              const label = button.querySelector(".buzz-button-label");
              const context = document.createElement("canvas").getContext("2d");
              context.font = getComputedStyle(label).font;
              if (
                (label.textContent.match(/\S+/g) ?? []).some(
                  (word) =>
                    context.measureText(word).width >
                    label.getBoundingClientRect().width,
                )
              )
                failures.push(
                  `${button.textContent}: action words break apart`,
                );
            }
            // Shared controls retain their authored 32px small or 40px default
            // minimum at 100%; enlarged labels may grow.
            const minimum = button.dataset.size === "sm" ? 32 : 40;
            if (scale === 100 && box.height !== minimum)
              failures.push(`${button.textContent}: default height changed`);
            // Compact Select deliberately ellipsizes its value; a text Range
            // includes hidden glyphs. Check the painted boxes and full-value
            // hint instead, without exempting lost clipping or escaping icons.
            const selectValue = button
              .closest('.buzz-select[data-variant="compact"]')
              ?.querySelector(".buzz-select-value");
            if (selectValue) {
              const style = getComputedStyle(selectValue);
              if (
                style.overflow !== "hidden" ||
                style.textOverflow !== "ellipsis" ||
                style.whiteSpace !== "nowrap" ||
                selectValue.getAttribute("title") !==
                  selectValue.textContent.trim()
              )
                failures.push(
                  `${button.textContent}: compact choice lost clipping or full-value hint`,
                );
            }
            const text = document.createRange();
            if (!selectValue) text.selectNodeContents(button);
            const content = selectValue
              ? [
                  ...button.querySelectorAll(
                    ".buzz-select-value, .buzz-dropdown-chevron",
                  ),
                ].map((node) => node.getBoundingClientRect())
              : [...text.getClientRects()];
            for (const line of content) {
              if (
                line.top < box.top ||
                line.bottom > box.bottom ||
                line.left < box.left ||
                line.right > box.right
              )
                failures.push(
                  `${button.textContent}: content overflows button`,
                );
            }
            const palette = button.closest("[data-accent-colors]");
            const visibleBounds = palette?.getBoundingClientRect() ?? box;
            if (
              visibleBounds.left < bounds.left ||
              visibleBounds.right > bounds.right
            )
              failures.push(
                `${button.textContent}: button [${visibleBounds.left}, ${visibleBounds.right}] overflows section [${bounds.left}, ${bounds.right}]; group inset ${getComputedStyle(button.closest(".buzz-settings-group") ?? root).getPropertyValue("--settings-group-inset")}`,
              );
          }
          return failures;
        }, scale),
      )
      .toEqual([]);
  };
  for (const scale of [100, 200]) {
    await selectSettingsSection(page, "Appearance");
    if (scale === 200) {
      for (let i = 0; i < 10; i++)
        await button(page, "Increase interface size").click();
    }
    await expect(
      page.getByRole("status", { name: "Interface size" }),
    ).toHaveText(`${scale}%`);
    for (const [width, mode] of [
      [320, "Light"],
      [800, "Dark"],
      [1280, "Light"],
    ]) {
      await page.setViewportSize({ width, height: 900 });
      await selectSettingsSection(page, "Appearance");
      const appearance = page.getByRole("region", {
        name: "Appearance",
        exact: true,
      });
      await chooseColorMode(page, mode);
      await expect(appearance.getByRole("button")).toHaveCount(
        scale === 100 ? 8 : 9,
      );
      await expect(
        appearance.getByRole("button", {
          name: "Reset interface size",
          exact: true,
        }),
      ).toHaveCount(scale === 100 ? 0 : 1);
      await page.evaluate(() => document.fonts.ready);
      await checkButtons(appearance, scale);
      const colors = appearance.locator("[data-accent-colors] button");
      await expect(colors).toHaveCount(6);
      await colors.first().focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      for (let index = 0; index < 6; index++) {
        if (index) await page.keyboard.press("Tab");
        await expect(colors.nth(index)).toBeFocused();
        await expect
          .poll(() =>
            colors.nth(index).evaluate((button) => {
              const box = button.getBoundingClientRect();
              const palette = button
                .closest("[data-accent-colors]")
                .getBoundingClientRect();
              const style = getComputedStyle(button);
              const ring =
                parseFloat(style.outlineWidth) +
                parseFloat(style.outlineOffset);
              return (
                ring === 4 &&
                box.left - ring >= palette.left &&
                box.right + ring <= palette.right &&
                box.top - ring >= palette.top &&
                box.bottom + ring <= palette.bottom
              );
            }),
          )
          .toBe(true);
      }
      await appearance.screenshot({
        path: info.outputPath(`appearance-${scale}-${width}-${mode}.png`),
      });
      // Icon buttons grow with the interface while keeping their square shape.
      // The shell toolbar stays mounted, though hidden, behind the modal.
      await expect(
        page.getByRole("button", {
          name: "Your profile",
          exact: true,
          includeHidden: true,
        }),
      ).toHaveAttribute("data-icon-size", "sm");
      await expect
        .poll(() =>
          settingsDialog(page)
            .locator("button[data-icon-size]")
            .evaluateAll(
              (buttons, scale) =>
                buttons
                  .filter((button) => button.getClientRects().length)
                  .map((button) => {
                    const box = button.getBoundingClientRect();
                    const sizes = {
                      sm: 32,
                      md: 40,
                      lg: 52,
                      compact: 32,
                      toolbar: 32,
                      default: 40,
                      large: 52,
                    };
                    return (
                      box.width ===
                        sizes[button.dataset.iconSize] * (scale / 100) &&
                      box.height === box.width
                    );
                  }),
              scale,
            ),
        )
        .not.toContain(false);
      await selectSettingsSection(page, "Manage plugins");
      const plugins = page.getByRole("region", {
        name: "Manage plugins",
        exact: true,
      });
      await expect(button(page, "Add")).toBeVisible();
      await checkButtons(plugins, scale);
      await button(page, "Add").click();
      const dialog = page.getByRole("dialog", { name: "Add a plugin" });
      await expect(dialog).toBeVisible();
      // Focus reveals below scroll the nested popup and body scrollers; let
      // the entrance settle before measuring or revealing anything.
      await settleDialogMotion(dialog);
      await checkButtons(dialog, scale);
      const folder = button(page, "Browse plugin folder");
      const repository = dialog.getByRole("textbox", {
        name: "Git or GitHub repository",
        exact: true,
      });
      if (scale === 200 && width === 320) {
        // The stacked acquisition sources retain reachable controls in the modal.
        await folder.focus();
        await page.keyboard.press("Tab");
        await expect(repository).toBeFocused();
        await expect(repository).toBeInViewport({ ratio: 1 });
        await repository.fill("example/plugins");
        await page.keyboard.press("Tab");
        await expect(
          dialog.getByRole("textbox", { name: "Branch or tag (optional)" }),
        ).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(
          dialog.getByRole("textbox", { name: "Folder (optional)" }),
        ).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(button(page, "Find plugins")).toBeFocused();
        await expect(button(page, "Find plugins")).toBeInViewport({ ratio: 1 });
      }
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(button(page, "Add")).toBeFocused();
      await page.screenshot({
        path: info.outputPath(`settings-buttons-${scale}-${width}.png`),
      });
    }
  }
});

test("manual Git release-ref guidance stays readable across scale and themes", async ({
  page,
  app,
}) => {
  await nativeImports(page);
  await openPlugins(page, app.origin);
  await page.setViewportSize({ width: 320, height: 900 });
  await selectSettingsSection(page, "Appearance");
  await chooseColorMode(page, "Light");
  await selectSettingsSection(page, "Manage plugins");
  await button(page, "Add").click();

  const dialog = page.getByRole("dialog", { name: "Add a plugin" });
  const guidance = dialog.getByText(
    /Leave blank to scan the repository’s default branch/,
  );
  const reference = dialog.getByRole("textbox", {
    name: "Branch or tag (optional)",
  });
  await expect(guidance).toBeVisible();
  await reference.scrollIntoViewIfNeeded();
  await expect(reference).toBeInViewport({ ratio: 1 });
  const bounds = await guidance.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  await selectSettingsSection(page, "Appearance");
  for (let i = 0; i < 10; i++)
    await button(page, "Increase interface size").click();
  await expect(page.getByRole("status", { name: "Interface size" })).toHaveText(
    "200%",
  );
  await chooseColorMode(page, "Dark");
  await page.setViewportSize({ width: 1280, height: 900 });
  await selectSettingsSection(page, "Manage plugins");
  await button(page, "Add").click();
  const enlargedDialog = page.getByRole("dialog", { name: "Add a plugin" });
  const enlargedGuidance = enlargedDialog.getByText(
    /Leave blank to scan the repository’s default branch/,
  );
  const enlargedReference = enlargedDialog.getByRole("textbox", {
    name: "Branch or tag (optional)",
  });
  await expect(enlargedGuidance).toBeVisible();
  await enlargedReference.scrollIntoViewIfNeeded();
  await expect(enlargedReference).toBeInViewport({ ratio: 1 });
  await button(page, "Browse plugin folder").focus();
  await page.keyboard.press("Tab");
  await expect(
    enlargedDialog.getByRole("textbox", { name: "Git or GitHub repository" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(enlargedReference).toBeFocused();
  await page.setViewportSize({ width: 320, height: 900 });
  await enlargedReference.scrollIntoViewIfNeeded();
  await expect(enlargedGuidance).toBeVisible();
  await expect(enlargedReference).toBeInViewport({ ratio: 1 });
  const narrowBounds = await enlargedGuidance.boundingBox();
  expect(narrowBounds).not.toBeNull();
  expect(narrowBounds.x).toBeGreaterThanOrEqual(0);
  expect(narrowBounds.x + narrowBounds.width).toBeLessThanOrEqual(320);

  await page.evaluate(() => {
    window.importAcquisitionError = "Git output exceeds the import size limit";
  });
  const enlargedRepository = enlargedDialog.getByRole("textbox", {
    name: "Git or GitHub repository",
  });
  await enlargedRepository.fill("https://example.org/plugins");
  await enlargedRepository.press("Enter");

  const alert = enlargedDialog.getByRole("alert");
  await expect(alert).toBeVisible();
  const refusal = alert.getByText(
    "Error: Git output exceeds the import size limit",
    { exact: true },
  );
  const recovery = alert.getByText(
    "Try another branch or tag. If the same output limit persists, ask the publisher for a ref or repository that Buzz can read.",
    { exact: true },
  );
  await expect(refusal).toBeVisible();
  await expect(recovery).toBeVisible();
  await refusal.scrollIntoViewIfNeeded();
  await expect(refusal).toBeInViewport({ ratio: 1 });
  await recovery.scrollIntoViewIfNeeded();
  await expect(recovery).toBeInViewport({ ratio: 1 });
  await expect(button(page, "Back")).toBeFocused();
  const alertBounds = await alert.boundingBox();
  expect(alertBounds).not.toBeNull();
  expect(alertBounds.x).toBeGreaterThanOrEqual(0);
  expect(alertBounds.x + alertBounds.width).toBeLessThanOrEqual(320);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press("Enter");
  await expect(enlargedRepository).toBeFocused();
  await expect(alert).toHaveCount(0);
});

test("folder/Git preview selects the exact subfolder and preserves enabled state through updates", async ({
  page,
  app,
}, info) => {
  await page.clock.install();
  await nativeImports(
    page,
    ["one", "two"].map((name, index) => ({
      path: index === 0 ? "." : "dist",
      manifest: {
        id: `example.${name}`,
        name: `Example ${name}`,
        description:
          "Review repository activity and share detailed project updates with your community and collaborators.",
        apiVersion: 1,
        host: {
          commands: [{ id: "check", program: "example-cli", args: ["status"] }],
        },
      },
      revision: name,
    })),
    { source: "/plugins/example", commit: null },
  );
  await openPlugins(page, app.origin);
  await button(page, "Add").click();
  const sourceDialog = page.getByRole("dialog");
  await expect(sourceDialog).toHaveCSS("opacity", "1");
  await animationsSettled(sourceDialog);
  await sourceDialog.screenshot({
    path: info.outputPath("plugin-source.png"),
  });
  await button(page, "Browse plugin folder").click();
  const skippedFolders = page.getByRole("region", {
    name: "Skipped folders",
  });
  await expect(skippedFolders.getByRole("list")).toHaveCSS(
    "list-style-type",
    "disc",
  );
  await expect(skippedFolders.getByRole("button")).toHaveCount(0);
  await expect(
    skippedFolders.getByText("broken: Missing file: broken/plugin.js", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveAccessibleName(
    "Choose a plugin",
  );
  await expect(page.getByRole("dialog")).toHaveAccessibleDescription(
    "Select a plugin to review before installing.",
  );
  await expect(
    page.getByRole("radiogroup", { name: "Choose a plugin" }),
  ).toBeVisible();

  await expect(page.getByRole("radio")).toHaveCount(2);
  await expect(
    page.getByRole("radio", { name: /Example one/ }),
  ).toHaveAccessibleDescription("/plugins/example · example.one");
  await expect(
    page.getByRole("radio", { name: /Example two/ }),
  ).toHaveAccessibleDescription("/plugins/example/dist · example.two");
  await expect(button(page, "Install plugin")).toHaveCount(0);
  await expect(button(page, "Continue")).toBeDisabled();
  await expect(
    page.getByRole("region", { name: "Computer access" }),
  ).toHaveCount(0);
  await page.getByRole("radio", { name: /Example two/ }).check();
  await expect(page.getByRole("radio", { name: /Example two/ })).toBeChecked();
  await expect(
    page.getByRole("heading", { name: "Example two", level: 3 }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 900, height: 700 });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-mode",
    "light",
  );
  await page
    .getByRole("dialog")
    .screenshot({ path: info.outputPath("plugin-choose-light.png") });
  await button(page, "Continue").click();
  await expect(page.getByRole("dialog")).toHaveAccessibleName(
    /^Review .+ access$/,
  );
  await expect(page.getByRole("dialog")).toHaveAccessibleDescription(
    "Only install code you trust.",
  );
  await expect(
    page.getByRole("region", { name: "Skipped folders" }),
  ).toHaveCount(0);
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Computer access" }),
  ).toBeVisible();
  await button(page, "Back").click();
  await expect(page.getByRole("radio", { name: /Example two/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /Example two/ })).toBeFocused();
  await button(page, "Continue").click();
  await page.setViewportSize({ width: 480, height: 700 });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  await page
    .getByRole("dialog")
    .screenshot({ path: info.outputPath("plugin-review-dark.png") });
  await page.setViewportSize({ width: 1440, height: 950 });
  await expect(
    page.getByRole("heading", { name: "Example two", level: 3 }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("switch", { name: "Enable plugin" }),
  ).toBeChecked();
  await page.getByRole("switch", { name: "Enable plugin" }).uncheck();
  await button(page, "Install plugin").click();
  await expectOnlySettings(page);
  await expect(
    page.getByRole("heading", { name: "Example two", level: 3 }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        window.importCalls.find((c) => c.command === "plugin_import_install")
          .args,
    ),
  ).toEqual({ token: expect.stringMatching(/^preview-\d+$/), path: "dist" });
  const enabled = pluginAction(page, "Example two");
  await expect(enabled).toHaveAccessibleName("Enable Example two");
  const row = button(page, "View Example two details");
  await expect(button(page, "Update Example two")).toHaveCount(0);
  for (const width of [1100, 768]) {
    await page.setViewportSize({ width, height: 950 });
    await row.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        row.evaluate((node) => {
          const description = node.querySelector('[id^="plugin-description-"]');
          const actions = [...node.parentElement.querySelectorAll("button")]
            .filter((button) => button !== node)
            .map((button) => button.getBoundingClientRect());
          // Ellipsis clips glyphs outside this box; Range rects include those hidden glyphs.
          const rect = description.getBoundingClientRect();
          const style = getComputedStyle(description);
          return (
            style.textOverflow === "ellipsis" &&
            style.overflow === "hidden" &&
            actions.every(
              (action) =>
                rect.right <= action.left ||
                rect.left >= action.right ||
                rect.bottom <= action.top ||
                rect.top >= action.bottom,
            )
          );
        }),
      )
      .toBe(true);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: info.outputPath("updatable-row-light.png") });
  await page.setViewportSize({ width: 480, height: 850 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({
    path: info.outputPath("updatable-row-dark-narrow.png"),
  });
  await page.setViewportSize({ width: 1440, height: 950 });

  await button(page, "View Example two details").click();
  await expect(button(page, "Reload")).toHaveCount(0);
  // Opening details narrows the catalog column, and the list's layout motion
  // can still move the row after a pointer has pressed its button. The enabled
  // state, not hit testing, is under test here.
  await activate(enabled);
  await expect(enabled).toHaveAccessibleName("Disable Example two");
  await expect(button(page, "Reload")).toHaveCount(0);
  const details = page.getByRole("complementary", {
    name: "Example two details",
  });
  const actionPositions = () =>
    details
      .getByRole("button", { name: /^(Disable|More plugin actions)$/ })
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const { x, y, width, height } = button.getBoundingClientRect();
          return { x, y, width, height };
        }),
      );
  await animationsSettled(details, { subtree: true });
  const settledActions = await actionPositions();
  await page.evaluate(() => {
    window.importCategory = "productivity";
  });
  await page.clock.runFor(5_000);
  // The open pane detects folder changes without a manual check.
  await expect(button(page, "Update")).toBeEnabled();
  const updatingPane = page.getByRole("complementary", {
    name: "Example two details",
  });
  await expect(
    updatingPane.getByRole("button", { name: "Disable", exact: true }),
  ).toBeVisible();
  await expect.poll(actionPositions).toEqual(settledActions);
  await expect(button(page, "Update Example two")).toBeVisible();
  await updatingPane.screenshot({
    path: info.outputPath("primary-update-pane.png"),
  });
  await button(page, "More plugin actions").click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "Review access",
    "Delete",
  ]);
  await page
    .getByRole("menu")
    .screenshot({ path: info.outputPath("primary-update-menu.png") });
  await page.keyboard.press("Escape");
  await updatingPane
    .getByRole("button", { name: "Disable", exact: true })
    .click();
  await updatingPane
    .getByRole("button", { name: "Enable", exact: true })
    .click();
  await button(page, "More plugin actions").click();
  await page
    .getByRole("menuitem", { name: "Review access", exact: true })
    .click();
  const accessDialog = page.getByRole("dialog", {
    name: "What this plugin can do",
  });
  await expect(
    accessDialog.getByRole("button", { name: /^Run example-cli/ }),
  ).toBeVisible();
  await accessDialog.getByRole("button", { name: /^Computer access/ }).click();
  await expect(
    accessDialog.getByRole("region", { name: "Plugin safety" }),
  ).toContainText("Plugins aren’t sandboxed");
  await accessDialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(button(page, "More plugin actions")).toBeFocused();
  await button(page, "Close plugin details").click();
  await button(page, "More actions for Example two").click();
  await page
    .getByRole("menuitem", { name: "Review access", exact: true })
    .click();
  await accessDialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(button(page, "More actions for Example two")).toBeFocused();
  expect(
    await page.evaluate(
      () =>
        window.importCalls
          .filter((c) => c.command === "plugin_update_check")
          .at(-1).args,
    ),
  ).toEqual({ id: "example.two" });
  await expectOnlySettings(page);
  await expect(button(page, "Check for updates")).toHaveCount(0);
  await button(page, "Update Example two").click();
  await expect(button(page, "Change source folder")).toHaveCount(0);
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(
    page.getByText(/may run immediately|earlier revision to roll back/),
  ).toHaveCount(0);
  await expect(button(page, "Update")).toBeEnabled();
  await button(page, "View unchanged declarations").click();
  await expect(page.getByRole("dialog")).toHaveAccessibleName(
    "Unchanged declarations",
  );
  await expect(button(page, "Back")).toBeFocused();
  await expect(button(page, "Update")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /^Run example-cli/ }),
  ).toBeVisible();
  await button(page, "Back").click();
  await expect(page.getByRole("dialog")).toHaveAccessibleName(
    "Update Example two",
  );
  await expect(button(page, "View unchanged declarations")).toBeFocused();
  await page
    .getByRole("dialog")
    .screenshot({ path: info.outputPath("plugin-update-review.png") });
  await button(page, "Update").click();
  await expectOnlySettings(page);
  await expect(enabled).toHaveAccessibleName("Disable Example two");
  await expect(button(page, "Close plugin details")).toBeFocused();
  await expect(
    page.getByRole("status").filter({ hasText: "Up to date" }),
  ).toBeVisible();
  await expect(button(page, "Update")).toHaveCount(0);
  await expect.poll(actionPositions).toEqual(settledActions);
  const pane = page.getByRole("complementary", { name: "Example two details" });
  const paneActions = pane.getByRole("button", {
    name: /^Disable$/,
  });
  await expect(paneActions).toHaveCount(1);
  await expect(paneActions).toHaveText(["Disable"]);
  await expect(button(page, "Delete")).toHaveCount(0);
  for (const [width, theme] of [
    [1440, "light"],
    [480, "dark"],
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.emulateMedia({ colorScheme: theme });
    await expect
      .poll(() =>
        paneActions.evaluateAll((buttons) => {
          const rects = buttons.map((node) => node.getBoundingClientRect());
          const row = buttons[0].parentElement.parentElement;
          const group = row.parentElement.getBoundingClientRect();
          const primary = row.getBoundingClientRect();
          const more = row
            .querySelector('[aria-label="More plugin actions"]')
            .getBoundingClientRect();
          return (
            Math.abs(primary.left - group.left) < 1 &&
            Math.abs(primary.right - group.right) < 1 &&
            Math.abs(more.top - rects[0].top) < 1 &&
            rects[0].right <= more.left &&
            Math.abs(more.right - group.right) < 1 &&
            rects.every(
              (rect, index) =>
                Math.abs(rect.left - group.left) < 1 &&
                (index === 0 ||
                  (Math.abs(rect.right - group.right) < 1 &&
                    rect.top >= primary.bottom)),
            )
          );
        }),
      )
      .toBe(true);
    await pane.screenshot({
      path: info.outputPath(`plugin-actions-${theme}-${width}.png`),
    });
    await button(page, "More plugin actions").click();
    const menu = page.getByRole("menu", { name: "Plugin actions" });
    await expect(menu).toBeInViewport();
    await menu.screenshot({
      path: info.outputPath(`plugin-menu-${theme}-${width}.png`),
    });
    await menu
      .getByRole("menuitem", { name: "Roll back", exact: true })
      .click();
    const rollback = page.getByRole("alertdialog", {
      name: "Roll back Example two?",
    });
    const cancel = rollback.getByRole("button", {
      name: "Cancel",
      exact: true,
    });
    await expect(
      rollback.getByRole("button", { name: "Roll back", exact: true }),
    ).toBeFocused();
    await expect(rollback).not.toContainText("enabled or disabled");
    const scrim = page.locator(".buzz-dialog-backdrop[data-alert-dialog]");
    await expect(scrim).toBeVisible();
    // The confirmation scrim must cover Settings, rather than sit behind it.
    const parentBox = await page
      .locator('[role="dialog"][data-navigation]')
      .boundingBox();
    await expect
      .poll(() =>
        scrim.evaluate(
          (element, point) => {
            return (
              document.elementFromPoint(point.x, point.y) === element &&
              getComputedStyle(element).backgroundColor !== "rgba(0, 0, 0, 0)"
            );
          },
          { x: parentBox.x + 12, y: parentBox.y + 12 },
        ),
      )
      .toBe(true);
    await expect(
      rollback.getByRole("button", { name: "Roll back", exact: true }),
    ).toBeVisible();
    await cancel.click();
    await expect(rollback).toHaveCount(0);
    await expect(paneActions).toHaveText(["Disable"]);
    await expect(button(page, "More plugin actions")).toBeFocused();
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  await button(page, "More plugin actions").focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("menuitem", { name: "Delete", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pane).toBeVisible();
  await expect(button(page, "More plugin actions")).toBeFocused();
  await button(page, "More plugin actions").click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const deletion = page.getByRole("alertdialog", {
    name: "Delete Example two?",
  });
  await expect(deletion).toBeVisible();
  await expect(
    deletion.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await deletion.screenshot({
    path: info.outputPath("plugin-delete-confirmation.png"),
  });
  await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(button(page, "More plugin actions")).toBeFocused();
  await button(page, "Close plugin details").click();
  await page
    .getByRole("region", { name: "Manage plugins", exact: true })
    .screenshot({ path: info.outputPath("plugin-row-update.png") });
  await button(page, "Add").click();
  await page.getByLabel("Git or GitHub repository").fill("example/plugins");
  await page.getByLabel("Branch or tag (optional)").fill("feature/plugins");
  await page.getByLabel("Folder (optional)").fill("plugins/");
  await button(page, "Find plugins").click();
  await expect(page.getByRole("radio")).toHaveCount(2);
  expect(
    await page.evaluate(
      () =>
        window.importCalls.find((c) => c.command === "plugin_import_git").args,
    ),
  ).toEqual({
    repository: "example/plugins",
    reference: "feature/plugins",
    path: "plugins",
  });
  await button(page, "Back").click();
  await expect(button(page, "Find plugins")).toBeFocused();
  await expect(page.getByLabel("Git or GitHub repository")).toHaveValue(
    "example/plugins",
  );
  await expect(page.getByLabel("Branch or tag (optional)")).toHaveValue(
    "feature/plugins",
  );
  await expect(page.getByLabel("Folder (optional)")).toHaveValue("plugins/");
  await page.getByLabel("Git or GitHub repository").fill("bad");
  await page.evaluate(() => {
    window.importDelay = true;
  });
  await button(page, "Find plugins").click();
  await expect(button(page, "Find plugins")).toBeDisabled();
  await page.evaluate(() => {
    window.importDelay = false;
    window.resolveImport();
  });
  await expect(
    page.getByRole("alert").filter({ hasText: "Repository unavailable" }),
  ).toBeVisible();
  await expect(button(page, "Find plugins")).toHaveCount(0);
  await button(page, "Back").click();
  await expect(button(page, "Find plugins")).toBeEnabled();
  await expect(button(page, "Find plugins")).toBeFocused();
  await expect(page.getByLabel("Git or GitHub repository")).toHaveValue("bad");
  await page.keyboard.press("Escape");
  await button(page, "Add").click();
  await button(page, "Browse plugin folder").click();
  await page.getByRole("radio", { name: /Example two/ }).check();
  await button(page, "Continue").click();
  await expect(
    page.getByRole("dialog", { name: "Already installed" }),
  ).toBeVisible();
  await page.getByRole("dialog").screenshot({
    path: info.outputPath("installed-open-dialog.png"),
  });
  await button(page, "Open in Buzz").click();
  await expectOnlySettings(page);
  await expect(pane).toBeVisible();
  await expect(button(page, "Close plugin details")).toBeFocused();
  await button(page, "Close plugin details").click();
  await expect(button(page, "View Example two details")).toBeFocused();
  await button(page, "View Example two details").click();
  await button(page, "More plugin actions").click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete plugin", exact: true })
    .click();
  await expect(button(page, "View Example two details")).toHaveCount(0);
});

test("resizing over the catalog keeps focus in visible plugin details", async ({
  page,
  app,
}) => {
  await nativeImports(page);
  await page.setViewportSize({ width: 1440, height: 950 });
  await openPlugins(page, app.origin);
  await button(page, "View github details").click();
  const pane = page.getByRole("complementary", { name: "github details" });
  const close = pane.getByRole("button", { name: "Close plugin details" });
  await expect(close).toBeFocused();
  await pluginAction(page, "github").focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(pane).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 950 });
  await button(page, "View github details").click();
  await button(page, "Add").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("Escape");
  await expectOnlySettings(page);
  await expect(close).toBeFocused();
});

test("leaving Settings discards a late preview without installing", async ({
  page,
  app,
}) => {
  await nativeImports(page);
  await openPlugins(page, app.origin);
  await page.evaluate(() => {
    window.importDelay = true;
  });
  await button(page, "Add").click();
  await button(page, "Browse plugin folder").click();
  await expect(page.getByText(/Reading plugin folders/)).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "Add a plugin" });
  await expect(
    dialog.getByRole("button", { name: "Close", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.evaluate(() => {
    location.hash = `buzz=${encodeURIComponent(
      JSON.stringify({
        version: 1,
        kind: "page",
        pluginId: "buzz.workflows",
        pageId: "workflows",
      }),
    )}`;
  });
  await expect(
    page.getByRole("heading", { name: "Workflows", exact: true }),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => window.resolveImport());
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.importCalls.filter(
            (c) => c.command === "plugin_import_discard",
          ).length,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(() =>
      window.importCalls.filter((c) => c.command === "plugin_import_install"),
    ),
  ).toEqual([]);
});

test("checked-in local examples activate and work independently", async ({
  page,
  app,
}) => {
  const samples = await Promise.all(
    ["counter", "notes"].map(async (name) => {
      const folder = new URL(
        `../../examples/plugins/${name}/`,
        import.meta.url,
      );
      return {
        path: name,
        manifest: JSON.parse(
          await readFile(new URL("manifest.json", folder), "utf8"),
        ),
        code: await readFile(new URL("plugin.js", folder), "utf8"),
        revision: name,
      };
    }),
  );
  await nativeImports(page, samples);
  await openPlugins(page, app.origin);
  for (const sample of samples) {
    await button(page, "Add").click();
    await button(page, "Browse plugin folder").click();
    await page
      .getByRole("radio", { name: new RegExp(sample.manifest.name) })
      .check();
    await button(page, "Continue").click();
    await button(page, "Install plugin").click();
    await expectOnlySettings(page);
    await expect(pluginAction(page, sample.manifest.name)).toHaveAccessibleName(
      `Disable ${sample.manifest.name}`,
    );
  }
  await closeSettings(page);
  await openPage(page, "Counter playground");
  await button(page, "Clicked 0 times").click();
  await expect(button(page, "Clicked 1 times")).toBeVisible();
  await openPage(page, "Notes playground");
  await page.getByLabel("Scratch note").fill("Hello plugin");
  await expect(page.getByRole("main").getByRole("status")).toHaveText(
    "12 characters",
  );
  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
  await pluginAction(page, "Counter playground").click();
  await closeSettings(page);
  const navigation = await pageChoices(page, "Counter playground");
  await expect(pageChoice(navigation, "Counter playground")).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Search Buzz", exact: true })
    .fill("Notes playground");
  await expect(pageChoice(navigation, "Notes playground")).toBeVisible();
});

// Browser-only: Settings -> manager -> runtime retries the cached installed module,
// keeping native acquisition and persistence separate from activation recovery.
test("Retry recovers installed activation without installing or enabling again", async ({
  page,
  app,
}) => {
  await nativeImports(page, [
    {
      path: "dist",
      revision: "one",
      manifest: { id: "example.retry", name: "Retry example", apiVersion: 1 },
      code: "export function apply() { globalThis.retryAttempts = (globalThis.retryAttempts ?? 0) + 1; if (globalThis.retryAttempts === 1) throw new Error('Temporary startup failure'); }",
    },
  ]);
  await openPlugins(page, app.origin);
  await button(page, "Add").click();
  await button(page, "Browse plugin folder").click();
  await button(page, "Install plugin").click();
  await expectOnlySettings(page);
  await button(page, "View Retry example details").click();
  const pane = page.getByRole("complementary", {
    name: "Retry example details",
  });
  await expect(pane.getByText("Up to date", { exact: true })).toBeVisible();
  await expect(pane.getByText(/Temporary startup failure/)).toBeVisible();
  const callsBefore = await page.evaluate(
    () =>
      window.importCalls.filter((c) =>
        /^(plugin_import_folder|plugin_import_install|plugin_change|plugin_reload)$/.test(
          c.command,
        ),
      ).length,
  );
  await button(page, "Retry").click();
  await expect
    .poll(() => page.evaluate(() => globalThis.retryAttempts))
    .toBe(2);
  await expect(button(page, "Retry")).toHaveCount(0);
  await expect(button(page, "Close plugin details")).toBeFocused();
  await expect(pane.getByText(/Temporary startup failure/)).toHaveCount(0);
  await expect(button(page, "Disable")).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.importCalls.filter((c) =>
          /^(plugin_import_folder|plugin_import_install|plugin_change|plugin_reload)$/.test(
            c.command,
          ),
        ).length,
    ),
  ).toBe(callsBefore);
});

// Browser-only: real modal focus and manager error propagation across the IPC boundary.
test("Add keeps a rejected install reachable and retries the same preview", async ({
  page,
  app,
}, info) => {
  await nativeImports(
    page,
    [
      {
        path: "dist",
        revision: "one",
        manifest: {
          id: "example.retry",
          name: "Retry plugin",
          description:
            "Review a local plugin and its computer access before installation.",
          apiVersion: 1,
          host: {
            networkOrigins: ["https://api.example.com"],
            commands: [
              {
                id: "status",
                program: "python3",
                args: ["-c", "print('plugin status')\n".repeat(80)],
              },
            ],
          },
        },
      },
    ],
    { source: "/plugins/example", commit: null, warnings: [] },
  );
  await openPlugins(page, app.origin);
  await button(page, "Add").click();
  await button(page, "Browse plugin folder").click();
  const dialog = page
    .getByRole("dialog")
    .and(page.locator('[aria-modal="true"]'));
  await expect(dialog).toHaveAccessibleName(
    "Review Retry plugin Plugin access",
  );
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await expect(
    dialog.getByText("Choose a plugin folder", { exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("heading", { name: "Retry plugin", exact: true }),
  ).toHaveCount(0);
  await expect(dialog.getByText("example.retry", { exact: true })).toHaveCount(
    0,
  );
  await expect(dialog.getByText(/^Source:/)).toHaveCount(0);
  await expect(
    dialog.getByText(
      "Review a local plugin and its computer access before installation.",
      { exact: true },
    ),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("region", { name: "Computer access" }),
  ).toBeVisible();
  await expect(dialog.getByText(/^Folder:/)).toHaveCount(0);
  await expect(
    dialog.getByRole("region", { name: "Plugin import preview" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("region", { name: "Add from folder" }),
  ).toBeHidden();
  await expect(dialog.getByRole("form", { name: "Add from Git" })).toBeHidden();
  await expect(
    dialog.getByRole("button", { name: "Back", exact: true }),
  ).toBeFocused();
  await expect(
    dialog.getByRole("button", { name: "Install plugin", exact: true }),
  ).toHaveAttribute("data-variant", "prominent");
  await expect(
    dialog.getByRole("region", { name: "Skipped folders" }),
  ).toHaveCount(0);
  const access = dialog.getByRole("region", { name: "Computer access" });
  await expect(access.getByText("Run python3")).toBeVisible();
  const summaryList = access.getByRole("region", { name: "Declared scopes" });
  const computer = access.getByRole("button", { name: /^Computer access/ });
  await expect(access.getByRole("button").first()).toHaveText(
    /Computer access/,
  );
  await expect(computer).toHaveAttribute("aria-expanded", "false");
  await computer.click();
  await expect(
    access.getByRole("region", { name: "Plugin safety" }),
  ).toBeVisible();
  await expect(
    access.getByRole("region", { name: "Plugin safety" }),
  ).toContainText("Plugins aren’t sandboxed");
  await dialog.screenshot({
    path: info.outputPath("computer-access-expanded.png"),
  });
  await computer.click();
  await expect(
    access.getByRole("region", { name: "Plugin safety" }),
  ).toHaveCount(0);
  await expect(access.getByText(/Inspect exact commands/)).toHaveCount(0);
  await expect(summaryList.getByRole("button")).toHaveCount(2);
  await expect(summaryList).toContainText("Connect to https://api.example.com");
  await expect(access.getByText(/^Command status:/)).toHaveCount(0);
  const details = access.getByRole("button", {
    name: /^Run python3/,
  });
  await details.focus();
  await details.press("Enter");
  await expect(access.getByText(/^Command status:/)).toBeVisible();
  const script = access.getByLabel("Argument 2").locator("code");
  expect(await script.textContent()).toBe(
    "print('plugin status')\n".repeat(80),
  );
  await expect(script.locator("..")).toHaveCSS("white-space", "pre-wrap");
  await expect(script).toHaveCSS("word-break", "normal");
  await expect(access.locator("code").first()).toHaveCSS(
    "font-family",
    /monospace/,
  );
  const codeRegion = access.getByRole("region", {
    name: "Command status details",
  });
  await expect(
    access.getByRole("button", { name: /^Connect to/ }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(
    access.getByRole("region", { name: /^HTTPS origin / }),
  ).toHaveCount(0);
  for (const [width, mode] of [
    [900, "light"],
    [480, "dark"],
  ]) {
    await page.setViewportSize({ width, height: 700 });
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await expect
      .poll(() =>
        codeRegion.evaluate((node) => ({
          bounded:
            node.clientHeight <= parseFloat(getComputedStyle(node).maxHeight),
          scrolls: node.scrollHeight > node.clientHeight,
          distinctBackground:
            getComputedStyle(node).backgroundColor !==
            getComputedStyle(node.closest('[role="dialog"]')).backgroundColor,
        })),
      )
      .toEqual({ bounded: true, scrolls: true, distinctBackground: true });
    await codeRegion.focus();
    // Cross a meaningful scroll boundary before reversing direction. End/Home
    // can align text lines instead of the padded scrollport edges across engines.
    const midpoint = await codeRegion.evaluate(
      (node) =>
        Math.min(node.clientHeight, node.scrollHeight - node.clientHeight) / 2,
    );
    for (const [key, direction] of [
      ["PageDown", "down"],
      ["PageUp", "up"],
    ]) {
      // Register before the key and finish native scrolling before reversing it.
      const completion = await codeRegion.evaluateHandle(
        (node, { midpoint, direction }) => ({
          done: new Promise((resolve) => {
            const settled = () => {
              const reached =
                direction === "down"
                  ? node.scrollTop > midpoint
                  : node.scrollTop < midpoint;
              // Focus/layout may finish an earlier scroll before this key does.
              if (!reached) return;
              node.removeEventListener("scrollend", settled);
              resolve();
            };
            node.addEventListener("scrollend", settled);
          }),
        }),
        { midpoint, direction },
      );
      await codeRegion.press(key);
      await completion.evaluate(({ done }) => done);
      await completion.dispose();
      const position = await codeRegion.evaluate((node) => node.scrollTop);
      if (direction === "down") expect(position).toBeGreaterThan(midpoint);
      else expect(position).toBeLessThan(midpoint);
    }
    // Position the capture independently of keyboard-scroll alignment.
    await codeRegion.evaluate((node) => {
      node.scrollTop = 0;
    });
    await details
      .locator("xpath=ancestor::*[contains(@class, 'buzz-accordion-item')][1]")
      .screenshot({
        path: info.outputPath(`plugin-scope-details-${mode}.png`),
      });
  }
  await details.press("Enter");
  await expect(details).toHaveAttribute("aria-expanded", "false");
  // Pointer expansion uses the shared height transition and Motion content fade.
  await details.click();
  const panel = summaryList.locator(".buzz-accordion-panel").first();
  await expect(panel).toHaveCSS("transition-property", "height");
  await expect(panel.locator(":scope > div")).toHaveCSS("opacity", "1");
  await expect(codeRegion).toBeVisible();
  await details.click();
  await expect(codeRegion).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await details.click();
  await expect(panel).toHaveCSS("transition-property", "none");
  await expect(panel.locator(":scope > div")).toHaveCSS("opacity", "1");
  await details.click();
  await expect(codeRegion).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const [width, mode] of [
    [900, "light"],
    [480, "dark"],
  ]) {
    await page.setViewportSize({ width, height: 700 });
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await dialog.screenshot({
      path: info.outputPath(`plugin-preview-${mode}.png`),
    });
  }
  await page.evaluate(() => {
    window.importInstallError =
      "Publisher mismatch. Choose a package from the installed publisher.";
  });
  await dialog
    .getByRole("button", { name: "Install plugin", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Install plugin", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => window.rejectInstall());
  await expect(dialog.getByRole("alert")).toContainText("Publisher mismatch");
  await expect(
    dialog.getByRole("region", { name: "Plugin import preview" }),
  ).toBeHidden();
  await expect(
    dialog.getByRole("region", { name: "Add from folder" }),
  ).toBeHidden();
  const back = dialog.getByRole("button", { name: "Back", exact: true });
  await expect(back).toBeFocused();
  for (const [width, mode] of [
    [900, "light"],
    [480, "dark"],
  ]) {
    await page.setViewportSize({ width, height: 700 });
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await expect(back).toBeInViewport({ ratio: 1 });
    await dialog.screenshot({
      path: info.outputPath(`plugin-install-error-${mode}.png`),
    });
  }
  await back.press("Enter");
  await expect(
    dialog.getByRole("region", { name: "Plugin import preview" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Install plugin", exact: true }),
  ).toBeFocused();
  await page.evaluate(() => {
    window.importInstallError = null;
  });
  await dialog
    .getByRole("button", { name: "Install plugin", exact: true })
    .press("Enter");
  await expectOnlySettings(page);
  await expect(pluginAction(page, "Retry plugin")).toHaveAccessibleName(
    "Disable Retry plugin",
  );
  const installs = await page.evaluate(() =>
    window.importCalls
      .filter((c) => c.command === "plugin_import_install")
      .map((c) => c.args),
  );
  expect(installs).toHaveLength(2);
  expect(installs[0]).toEqual({
    token: expect.stringMatching(/^preview-\d+$/),
    path: "dist",
  });
  expect(installs[1]).toEqual(installs[0]);
});

// Browser-only: the real modal must retain keyboard focus through failed retries.
for (const source of ["folder", "git"]) {
  test(`saved ${source} acquisition retries stay focused inside the update modal`, async ({
    page,
    app,
  }) => {
    const sample = {
      path: "dist",
      revision: "one",
      manifest: { id: "example.recovery", name: "Recovery", apiVersion: 1 },
    };
    await nativeImports(page, [sample]);
    await openPlugins(page, app.origin);
    await button(page, "Add").click();
    if (source === "git") {
      await page.getByLabel("Git or GitHub repository").fill("example/plugins");
      await button(page, "Find plugins").click();
    } else await button(page, "Browse plugin folder").click();
    await button(page, "Install plugin").click();
    await expectOnlySettings(page);
    await button(page, "View Recovery details").click();
    await page.evaluate(() => {
      window.importCategory = "productivity";
    });
    if (source === "git") {
      await button(page, "Check for updates").click();
    } else {
      await expect(button(page, "Update")).toBeVisible();
    }
    await page.evaluate(() => {
      window.importAcquisitionError = "Saved source unavailable";
    });
    await button(page, "Update").click();
    const dialog = page.getByRole("dialog", {
      name: "Update plugin",
      exact: true,
    });
    const retry = dialog.getByRole("button", {
      name: "Try again",
      exact: true,
    });
    await expect(dialog.getByRole("alert")).toContainText(
      "Saved source unavailable",
    );
    await expect(retry).toBeFocused();
    await retry.press("Enter");
    await expect(dialog.getByRole("alert")).toContainText(
      "Saved source unavailable",
    );
    await expect(retry).toBeFocused();
    await page.evaluate(() => {
      window.importAcquisitionError = null;
    });
    await retry.press("Enter");
    const review = page.getByRole("dialog", {
      name: "Update Recovery",
      exact: true,
    });
    await expect(
      review.getByRole("button", { name: "Update", exact: true }),
    ).toBeFocused();
  });
}

for (const mode of ["Light", "Dark"]) {
  test(`plugin deep link opens the consent flow in ${mode} mode`, async ({
    page,
    app,
  }, info) => {
    const repository = "ssh://git@github.com/example/plugin.git";
    const reference = "release/stable";
    const link = `buzz://plugin-install?repository=${encodeURIComponent(repository)}&ref=${encodeURIComponent(reference)}`;
    await nativeImports(
      page,
      [
        {
          path: ".",
          manifest: {
            id: "example.linked",
            name: "Linked plugin",
            apiVersion: 1,
            host: { files: true },
          },
          revision: "one",
        },
      ],
      { warnings: [] },
      [link],
    );
    await page.goto(app.origin);
    const review = page.getByRole("dialog", {
      name: "Review Linked plugin Plugin access",
      exact: true,
    });
    await expect(review).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Computer access" }),
    ).toBeVisible();
    await review.getByRole("button", { name: "Back", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Add a plugin",
      exact: true,
    });
    await expect(dialog.getByLabel("Git or GitHub repository")).toHaveValue(
      repository,
    );
    await expect(dialog.getByLabel("Branch or tag (optional)")).toHaveValue(
      reference,
    );
    await dialog.press("Escape");
    await expect(dialog).toBeHidden();
    await selectSettingsSection(page, "Appearance");
    await page.goBack();
    await expect(dialog).toBeHidden();
    await expect(review).toBeHidden();
    await selectSettingsSection(page, "Appearance");
    await chooseColorMode(page, mode);
    await page.evaluate((link) => window.deliverPluginLink(link), link);
    await expect(review).toBeVisible();
    await review.press("Escape");
    await expect(review).toBeHidden();
    await page.evaluate((link) => window.deliverPluginLink(link), link);
    await expect(review).toBeVisible();
    const install = page.getByRole("button", {
      name: "Install plugin",
      exact: true,
    });
    await expect(install).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Computer access" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        window.importCalls.filter(
          (call) => call.command === "plugin_import_install",
        ),
      ),
    ).toHaveLength(0);
    await page.screenshot({
      path: info.outputPath(`plugin-link-${mode.toLowerCase()}.png`),
    });
    await install.click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.importCalls.filter(
              (call) => call.command === "plugin_import_install",
            ).length,
        ),
      )
      .toBe(1);
    await expect(review).toBeHidden();
    await selectSettingsSection(page, "Appearance");
    await page.goBack();
    await expect(review).toBeHidden();
    await expect(dialog).toBeHidden();
  });
}

test("a linked preview can close during acquisition and a later link still opens", async ({
  page,
  app,
}) => {
  const link = "buzz://plugin-install?repository=org%2Frepo&ref=first";
  await nativeImports(
    page,
    [
      {
        path: ".",
        manifest: {
          id: "example.linked",
          name: "Linked",
          apiVersion: 1,
          host: { files: true },
        },
        revision: "one",
      },
    ],
    { warnings: [] },
    [link],
    true,
  );
  await page.goto(app.origin);
  const loading = page.getByRole("dialog", {
    name: "Add a plugin",
    exact: true,
  });
  await expect(loading).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => typeof window.resolveImport))
    .toBe("function");
  await expect(
    loading.getByRole("button", { name: "Close", exact: true }),
  ).toBeEnabled();
  await loading.press("Escape");
  await expect(loading).toBeHidden();
  await page.evaluate((link) => {
    window.importDelay = false;
    window.deliverPluginLink(link.replace("ref=first", "ref=next"));
  }, link);
  await expect(loading).toBeVisible();
  await page.evaluate(() => window.resolveImport());
  const review = page.getByRole("dialog", {
    name: "Review Linked Plugin access",
    exact: true,
  });
  await expect(review).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.importCalls.filter(
        (call) => call.command === "plugin_import_install",
      ),
    ),
  ).toHaveLength(0);
  expect(
    await page.evaluate(() =>
      window.importCalls
        .filter((call) => call.command === "plugin_import_git")
        .map((call) => call.args.reference),
    ),
  ).toEqual(["first", "next"]);
});

const artifactSha =
  "13fca413ba8975075fdec01a0087be6114ace8d935055f7d9ab1d57dd8e706a5";
const artifactUrl = `https://plugins.example.org/artifacts/example.artifact-${artifactSha}.json`;
const artifactPlugin = [
  {
    path: ".",
    manifest: {
      id: "example.artifact",
      name: "Artifact",
      apiVersion: 1,
      host: { files: true },
    },
    revision: artifactSha,
  },
];
async function recommendArtifact(page, sha256 = artifactSha) {
  await page.addInitScript(
    (policy) => {
      window.managedPolicy = policy;
    },
    {
      status: "ready",
      path: "/fixture/managed-plugins.json",
      source: "Example Org",
      problems: [],
      plugins: [{ id: "example.artifact", url: artifactUrl, sha256 }],
    },
  );
}
async function openRecommendedPlugins(page, origin) {
  await page.goto(origin);
  await openSettings(page);
  await selectSettingsSection(
    page,
    "Manage plugins 1 recommended plugin",
    "Manage plugins",
  );
}
async function servesArtifact(page) {
  await page.addInitScript((sha) => {
    window.artifactSha256 = sha;
  }, artifactSha);
}
const importCalls = (page) =>
  page.evaluate(() =>
    window.importCalls
      .filter(({ command }) =>
        [
          "plugin_import_url",
          "plugin_import_git",
          "plugin_import_install",
        ].includes(command),
      )
      .map(({ command, args }) => ({ command, args })),
  );

test("a recommended plugin URL installs the pinned artifact without Git", async ({
  page,
  app,
}) => {
  await nativeImports(page, artifactPlugin, { warnings: [] });
  await recommendArtifact(page);
  await servesArtifact(page);
  await openRecommendedPlugins(page, app.origin);
  const recommended = page.getByRole("region", {
    name: "Recommended by Example Org",
    exact: true,
  });
  await expect(recommended).toContainText(artifactUrl);
  await recommended
    .getByRole("button", { name: "Review and install example.artifact" })
    .click();
  const review = page.getByRole("dialog", {
    name: "Review Artifact Plugin access",
    exact: true,
  });
  await expect(review).toContainText(`SHA-256: ${artifactSha}`);
  await expect(review).toContainText("Recommended by Example Org");
  await review
    .getByRole("button", { name: "Install plugin", exact: true })
    .click();
  await expect(review).toBeHidden();
  await expect(recommended).toBeHidden();
  await expect(pluginAction(page, "Artifact")).toHaveAccessibleName(
    "Disable Artifact",
  );
  expect(await importCalls(page)).toEqual([
    {
      command: "plugin_import_url",
      args: { url: artifactUrl, sha256: artifactSha },
    },
    {
      command: "plugin_import_install",
      args: { token: "preview-1", path: "." },
    },
  ]);
});

test("a recommended plugin URL whose download doesn't match its SHA-256 never installs", async ({
  page,
  app,
}) => {
  const pinned = "0".repeat(64);
  await nativeImports(page, artifactPlugin, { warnings: [] });
  await recommendArtifact(page, pinned);
  await servesArtifact(page);
  await openRecommendedPlugins(page, app.origin);
  await page
    .getByRole("button", { name: "Review and install example.artifact" })
    .click();
  const review = page.getByRole("dialog", {
    name: "Review example.artifact",
    exact: true,
  });
  await expect(review.getByRole("alert")).toHaveText(
    `The downloaded plugin has SHA-256 ${artifactSha}, not the expected ${pinned}`,
  );
  await expect(
    review.getByRole("button", { name: "Install plugin" }),
  ).toHaveCount(0);
  expect(await importCalls(page)).toEqual([
    {
      command: "plugin_import_url",
      args: { url: artifactUrl, sha256: pinned },
    },
  ]);
});

test("an artifact link reviews and installs the pinned URL", async ({
  page,
  app,
}) => {
  const link = `buzz://plugin-install?id=example.artifact&url=${encodeURIComponent(artifactUrl)}&sha256=${artifactSha}`;
  await nativeImports(page, artifactPlugin, { warnings: [] }, [link]);
  await servesArtifact(page);
  await page.goto(app.origin);
  const review = page.getByRole("dialog", {
    name: "Review Artifact Plugin access",
    exact: true,
  });
  await expect(review).toContainText("Requested by A link");
  await expect(review).toContainText(artifactUrl);
  await expect(review).toContainText(`SHA-256: ${artifactSha}`);
  await review
    .getByRole("button", { name: "Install plugin", exact: true })
    .click();
  await expect(review).toBeHidden();
  await settingsDialog(page)
    .getByRole("button", { name: "View Artifact details", exact: true })
    .click();
  const updates = page.getByRole("region", {
    name: "Plugin updates",
    exact: true,
  });
  await expect(updates).toContainText(artifactUrl);
  await expect(updates).toContainText(`SHA-256: ${artifactSha}`);
  await expect(page.getByText(/No saved source/)).toHaveCount(0);
  expect(await importCalls(page)).toEqual([
    {
      command: "plugin_import_url",
      args: { url: artifactUrl, sha256: artifactSha },
    },
    {
      command: "plugin_import_install",
      args: { token: "preview-1", path: "." },
    },
  ]);
});

test("a Git-installed plugin reviews its URL self-update and survives requester replacement", async ({
  page,
  app,
}) => {
  const sample = {
    ...artifactPlugin[0],
    code: `export function apply(ctx) {
      const installer = ctx.reflect.get("pluginInstaller");
      window.requestMigration = () => {
        window.migrationOutcome = "pending";
        installer.requestInstall(${JSON.stringify({ id: "example.artifact", url: artifactUrl, sha256: artifactSha })})
          .then(result => { window.migrationOutcome = result; });
      };
      ctx.effect(() => () => { window.migrationDisposals = (window.migrationDisposals ?? 0) + 1; });
    }`,
  };
  await page.addInitScript((sample) => {
    window.installedPlugins = [
      {
        ...sample,
        source: "external",
        enabled: true,
        revision: "git-revision",
        previous: null,
        reloadable: false,
        error: null,
        updateSource: {
          repository: "https://example.com/plugins",
          reference: "v1",
          path: ".",
        },
      },
    ];
  }, sample);
  await nativeImports(page, [sample], { warnings: [] });
  await servesArtifact(page);
  await page.goto(app.origin);
  await expect
    .poll(() => page.evaluate(() => typeof window.requestMigration))
    .toBe("function");
  await page.evaluate(() => window.requestMigration());
  const migrationReview = page
    .getByRole("dialog", { name: "Update Artifact", exact: true })
    .filter({
      hasText:
        "This update switches this plugin from Git to a packaged download.",
    });
  await expect(migrationReview).toContainText(artifactUrl);
  await migrationReview
    .getByRole("button", { name: "Update", exact: true })
    .click();
  await expect(migrationReview).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => window.migrationOutcome))
    .toBe("updated");
  await expect
    .poll(() => page.evaluate(() => window.migrationDisposals))
    .toBe(1);
  await expect(pluginAction(page, "Artifact")).toHaveAccessibleName(
    "Disable Artifact",
  );
  await button(page, "View Artifact details").click();
  await expect(
    page.getByRole("region", { name: "Plugin updates", exact: true }),
  ).toContainText(artifactUrl);
  expect(
    await page.evaluate(() =>
      window.importCalls.filter(({ command }) => command === "plugin_change"),
    ),
  ).toEqual([]);
  // Startup may check the installed Git source before this URL migration.
  const migrationCalls = (await importCalls(page)).filter(
    ({ command, args }) => command !== "plugin_import_git" || !args?.checkOnly,
  );
  expect(migrationCalls).toEqual([
    {
      command: "plugin_import_url",
      args: { url: artifactUrl, sha256: artifactSha },
    },
    {
      command: "plugin_import_install",
      args: { token: "preview-1", path: "." },
    },
  ]);
});

// Native IPC throws Git's own text, as plugin_import_git does when offline.
test("a failed update check stays on its Settings row, and Check again clears it while it checks", async ({
  page,
  app,
}) => {
  const offline =
    "Git could not read this repository: fatal: unable to access 'https://github.com/acme/standup-notes/': Could not resolve host: github.com";
  await page.addInitScript((offline) => {
    window.gitCheckError = offline;
    window.installedPlugins = [
      {
        manifest: {
          id: "acme.standup-notes",
          name: "Standup Notes",
          apiVersion: 1,
          updates: { defaultEnabled: true },
        },
        source: "external",
        enabled: true,
        revision: "one",
        previous: null,
        reloadable: true,
        error: null,
        updateSource: {
          repository: "https://github.com/acme/standup-notes",
          reference: "main",
          path: ".",
        },
      },
    ];
  }, offline);
  await nativeImports(page, [
    {
      path: ".",
      revision: "one",
      manifest: {
        id: "acme.standup-notes",
        name: "Standup Notes",
        apiVersion: 1,
        updates: { defaultEnabled: true },
      },
    },
  ]);
  const checks = () =>
    page.evaluate(
      () =>
        window.importCalls.filter(
          (call) =>
            call.command === "plugin_import_git" && call.args?.checkOnly,
        ).length,
    );
  const notice = page.getByText("Couldn’t check Standup Notes for updates");
  await page.goto(app.origin);
  await expect.poll(checks).toBe(1);
  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
  const status = settingsDialog(page).getByText("Couldn’t check for updates.", {
    exact: true,
  });
  await expect(status).toBeVisible();
  // The check that failed in the background raised nothing over the app.
  await expect(notice).toHaveCount(0);
  await expect(page.getByText(/Cannot check/)).toHaveCount(0);
  const details = settingsDialog(page).locator("details", {
    hasText: "Could not resolve host",
  });
  await expect(details).not.toHaveAttribute("open");
  await details.getByText("Details", { exact: true }).click();
  await expect(details).toHaveAttribute("open");
  await expect(details).toContainText(offline);

  // Hold the check so its in-progress row can be observed.
  await page.evaluate(() => {
    window.heldGitCheck = new Promise((resolve) => {
      window.releaseGitCheck = resolve;
    });
  });
  const again = button(page, "Check again");
  const checking = settingsDialog(page).locator(
    '[data-buzz-ui][aria-busy="true"]',
  );
  await again.click();
  await expect(status).toHaveCount(0);
  await expect(again).toHaveCount(0);
  await expect(checking).toHaveCount(1);
  await expect(
    settingsDialog(page).getByRole("button", {
      name: "View Standup Notes details",
    }),
  ).toBeFocused();
  await expect.poll(checks).toBe(2);
  // Still offline, the check fails again and its status returns to the row.
  await page.evaluate(() => window.releaseGitCheck());
  await expect(status).toBeVisible();
  await expect(status).toHaveAttribute("role", "alert");
  await expect(again).toBeVisible();
  await expect(details).toContainText(offline);
  await expect(notice).toHaveCount(0);
  await expect(page.getByText(/Check your connection/)).toHaveCount(0);

  // Back online, Check again finds nothing wrong and the status goes.
  await page.evaluate(() => {
    window.heldGitCheck = undefined;
    window.gitCheckError = undefined;
  });
  await again.click();
  await expect.poll(checks).toBe(3);
  // The check has finished once its row is no longer busy.
  await expect(checking).toHaveCount(0);
  await expect(status).toHaveCount(0);
  await expect(again).toHaveCount(0);
  await expect(notice).toHaveCount(0);
  await expect(page.getByText("Update Standup Notes")).toHaveCount(0);
});

test("one notification-button click opens a review after a concurrent update check", async ({
  page,
  app,
}, info) => {
  const repository = "https://github.com/example-org/personal-plugins.git";
  const plugin = (id, name, path) => ({
    manifest: {
      id,
      name,
      apiVersion: 1,
      updates: { defaultEnabled: true },
    },
    source: "external",
    enabled: true,
    revision: "installed",
    previous: null,
    reloadable: true,
    error: null,
    updateSource: { repository, reference: "main", path },
  });
  const sample = {
    path: "plugins/notes",
    revision: "available",
    manifest: {
      id: "example.notes",
      name: "Notes",
      apiVersion: 1,
      updates: { defaultEnabled: true },
    },
  };
  await page.addInitScript(
    (installedPlugins) => {
      window.installedPlugins = installedPlugins;
    },
    [
      plugin("example.notes", "Notes", sample.path),
      plugin("example.missing", "Missing", sample.path),
    ],
  );
  await nativeImports(page, [sample], { source: repository, warnings: [] });
  const checks = () =>
    page.evaluate(
      () =>
        window.importCalls.filter(
          (call) =>
            call.command === "plugin_import_git" && call.args?.checkOnly,
        ).length,
    );
  await page.goto(app.origin);
  await expect.poll(checks).toBe(1);
  const notice = page.getByRole("dialog", {
    name: "Update Notes",
    exact: true,
  });
  await expect(
    notice.getByRole("button", { name: "Update and reload", exact: true }),
  ).toBeVisible();
  await notice.screenshot({ path: info.outputPath("notification-before.png") });
  const manage = notice.getByRole("button", {
    name: "Manage Notes update checks",
    exact: true,
  });
  await manage.focus();
  await manage.press("Enter");
  await expect(settingsDialog(page)).toBeVisible();
  const details = page.getByRole("complementary", { name: "Notes details" });
  await expect(details).toBeVisible();
  await expect(notice).toBeVisible();
  const actions = page.getByRole("menu", { name: "Plugin actions" });
  await expect(
    actions.getByRole("menuitemcheckbox", {
      name: "Check for updates automatically",
    }),
  ).toBeFocused();
  // Follow the focused menu → details → Settings path while the notice stays above it.
  await page.keyboard.press("Escape");
  await expect(actions).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(settingsDialog(page)).toHaveCount(0);

  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
  const again = settingsDialog(page).getByRole("button", {
    name: "Check again",
    exact: true,
  });
  await expect(again).toBeVisible();
  await page.evaluate(() => {
    window.heldGitCheck = new Promise((resolve) => {
      window.releaseGitCheck = resolve;
    });
  });
  await again.click();
  await expect.poll(checks).toBe(2);
  await page.keyboard.press("Escape");
  await expect(settingsDialog(page)).toHaveCount(0);

  await page.setViewportSize({ width: 480, height: 700 });
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "dark";
    document.documentElement.style.fontSize = "20px";
  });
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  const update = notice.getByRole("button", {
    name: "Update and reload",
    exact: true,
  });
  await update.click();
  try {
    await expect(
      notice.getByRole("button", { name: "Preparing update…", exact: true }),
    ).toBeDisabled();
    await notice.screenshot({
      path: info.outputPath("notification-refresh.png"),
    });
  } finally {
    await page.evaluate(() => window.releaseGitCheck());
  }

  const review = page.getByRole("dialog", {
    name: "Update Notes",
    exact: true,
  });
  const confirm = review.getByRole("button", { name: "Update", exact: true });
  await expect(confirm).toBeVisible();
  await expect(confirm).toBeEnabled();
  expect(
    await page.evaluate(
      () =>
        window.importCalls.filter(
          (call) => call.command === "plugin_import_install",
        ).length,
    ),
  ).toBe(0);
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "light";
  });
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-mode",
    "light",
  );
  await review.screenshot({ path: info.outputPath("notification-review.png") });
});

test("a policy's automatic install is noted once and labelled in Settings", async ({
  page,
  app,
}, info) => {
  await page.addInitScript(
    ({ policy, plugin }) => {
      window.managedPolicy = policy;
      window.installedPlugins = [plugin];
    },
    {
      policy: {
        status: "ready",
        path: "/fixture/managed-plugins.json",
        source: "Example Org",
        problems: [],
        plugins: [
          {
            id: "example.artifact",
            url: artifactUrl,
            sha256: artifactSha,
            install: "automatic",
            update: "automatic",
          },
        ],
        automatic: [
          {
            id: "example.artifact",
            name: "Artifact",
            revision: artifactSha,
            action: "installed",
          },
        ],
      },
      plugin: {
        manifest: artifactPlugin[0].manifest,
        source: "external",
        enabled: true,
        revision: artifactSha,
        previous: null,
        reloadable: true,
        error: null,
        updateSource: { url: artifactUrl },
      },
    },
  );
  await nativeImports(page, artifactPlugin, { warnings: [] });
  await page.setViewportSize({ width: 1100, height: 800 });
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await page.goto(app.origin);
    const notice = page.getByText("Example Org installed Artifact", {
      exact: true,
    });
    await expect(notice).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`automatic-notice-${mode}.png`),
    });
    const toast = page.locator("[data-sonner-toast]").filter({ has: notice });
    await expect(toast).toHaveAttribute("data-mounted", "true");
    await animationsSettled(toast, { subtree: true });
    await toast.hover();
    await button(page, "Dismiss automatic plugin changes").click();
    await expect(notice).toBeHidden();
    await openSettings(page);
    await selectSettingsSection(page, "Manage plugins");
    const label = "Managed by Example Org · updates automatically";
    const row = button(page, "View Artifact details");
    await expect(row.getByText(label, { exact: true })).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`automatic-managed-row-${mode}.png`),
    });
    await row.click();
    const details = page.getByRole("complementary", {
      name: "Artifact details",
    });
    await expect(details.getByText(label, { exact: true })).toBeVisible();
    await animationsSettled(details, { subtree: true });
    await page.screenshot({
      path: info.outputPath(`automatic-managed-details-${mode}.png`),
    });
    await closeSettings(page);
  }
});

async function installedDocumentReader(page, app, { clipGuide = false } = {}) {
  await nativeImports(
    page,
    [
      {
        path: "documents",
        revision: "documents",
        manifest: { id: "example.documents", name: "Documents", apiVersion: 1 },
        code: `export const inject = ["react", "pages", "conversation", "panels", "relay"]; export const apply = (ctx) => (${documentPlugin.toString()})(ctx, ${clipGuide});`,
      },
    ],
    {},
    [],
    false,
    true,
  );
  await openPlugins(page, app.origin);
  await button(page, "Add").click();
  await button(page, "Browse plugin folder").click();
  await button(page, "Install plugin").click();
  await expectOnlySettings(page);
  await closeSettings(page);
  await openPage(page, "Documents");
  return page.getByRole("region", {
    name: "Document reader",
    exact: true,
  });
}

test("document formatting floats over scrollable content", async ({
  page,
  app,
}) => {
  const reader = await installedDocumentReader(page, app, { clipGuide: true });
  await page.locator("html").evaluate((root) => {
    root.style.fontSize = "125%";
  });

  // Guide supplies a toolbar slot and Reference uses the editor's own anchor.
  for (const [name, width] of [
    ["Guide", 1280],
    ["Reference", 480],
  ]) {
    await page.setViewportSize({ width, height: 600 });
    await reader.getByRole("tab", { name, exact: true }).click();
    const panel = reader.getByRole("tabpanel", { name, exact: true });
    const scroll = panel.getByRole("region", { name: "Document scroll area" });
    const originalPadding = await scroll.evaluate(
      (area) => getComputedStyle(area).scrollPaddingBlockEnd,
    );
    await panel.getByRole("button", { name: `Edit ${name}` }).click();
    const toolbar = panel.getByRole("group", { name: "Document formatting" });
    if (name === "Guide") {
      const wrapper = panel.getByRole("region", { name: "Guide width limit" });
      await expect(wrapper).toHaveCSS("overflow-y", "auto");
      expect(
        await wrapper.evaluate((el) => el.scrollHeight - el.clientHeight),
      ).toBe(0);
      await expect.soft(wrapper).toHaveCSS("scroll-padding-block-end", "auto");
    }
    expect
      .soft(
        await scroll.evaluate((area) =>
          parseFloat(getComputedStyle(area).scrollPaddingBlockEnd),
        ),
        `${name} formatting clearance on the pane`,
      )
      .toBeGreaterThan(parseFloat(originalPadding));
    if (name === "Guide") {
      const wrapper = panel.getByRole("region", { name: "Guide width limit" });
      await wrapper.evaluate((el) => {
        el.style.maxHeight = "200px";
      });
      await expect(scroll).toHaveCSS(
        "scroll-padding-block-end",
        originalPadding,
      );
      await expect(wrapper).not.toHaveCSS("scroll-padding-block-end", "auto");
      await wrapper.evaluate((el) => {
        el.style.maxHeight = "";
      });
      await expect(wrapper).toHaveCSS("scroll-padding-block-end", "auto");
      await expect(scroll).not.toHaveCSS(
        "scroll-padding-block-end",
        originalPadding,
      );
    }
    const overlap = async () =>
      scroll.evaluate(
        (area, bounds) => {
          const rect = area.getBoundingClientRect();
          return (
            bounds &&
            bounds.y > rect.top &&
            bounds.y + bounds.height <= rect.bottom &&
            bounds.y + bounds.height <= innerHeight &&
            bounds.x >= rect.left &&
            bounds.x + bounds.width <= rect.right
          );
        },
        await toolbar.boundingBox(),
      );

    await expect(toolbar).toHaveCSS("position", "absolute");
    await expect.poll(overlap).toBe(true);
    await scroll.evaluate((area) => {
      area.scrollTop = area.scrollHeight;
    });
    await expect.poll(overlap).toBe(true);
    const end = panel
      .getByRole("textbox", { name: "Document body" })
      .getByText("const line39 = 39;", { exact: false });
    await expect(end).toBeVisible();
    const toolbarTop = (await toolbar.boundingBox()).y;
    const lastLineBottom = await end.evaluate((code) => {
      const range = document.createRange();
      range.selectNodeContents(code);
      return range.getBoundingClientRect().bottom;
    });
    expect(lastLineBottom).toBeLessThan(toolbarTop);

    const editor = panel.getByRole("textbox", { name: "Document body" });
    const selectionHeadBottom = (collapsed) =>
      editor.evaluate(async (field, collapsed) => {
        await new Promise(requestAnimationFrame);
        const selection = field.ownerDocument.getSelection();
        if (
          selection?.isCollapsed !== collapsed ||
          !selection.focusNode ||
          !field.contains(selection.focusNode)
        )
          throw new Error("Expected the selection head in the document editor");
        const head = field.ownerDocument.createRange();
        head.setStart(selection.focusNode, selection.focusOffset);
        const bounds = head.getBoundingClientRect();
        if (!bounds.height)
          throw new Error("Expected a measurable selection head");
        return bounds.bottom;
      }, collapsed);
    await editor.getByRole("heading", { name, exact: true }).click();
    const initialScroll = await scroll.evaluate((area) => area.scrollTop);
    const obscured = [];
    for (let line = 0; line < 32; line++) {
      await page.keyboard.press("Enter");
      await page.keyboard.type("Typing line");
      const caretBottom = await selectionHeadBottom(true);
      if (caretBottom > (await toolbar.boundingBox()).y) obscured.push(line);
    }
    expect(await scroll.evaluate((area) => area.scrollTop)).toBeGreaterThan(
      initialScroll,
    );
    expect
      .soft(obscured, `${name} lines behind the formatting bar`)
      .toEqual([]);

    await editor.getByText("Typing line", { exact: true }).first().click();
    const rangeStart = await scroll.evaluate((area) => area.scrollTop);
    const hiddenSelectionHeads = [];
    for (let line = 0; line < 28; line++) {
      await page.keyboard.press("Shift+ArrowDown");
      const bottom = await selectionHeadBottom(false);
      if (bottom > (await toolbar.boundingBox()).y)
        hiddenSelectionHeads.push(line);
    }
    expect(await scroll.evaluate((area) => area.scrollTop)).toBeGreaterThan(
      rangeStart,
    );
    expect
      .soft(
        hiddenSelectionHeads,
        `${name} selection heads behind the formatting bar`,
      )
      .toEqual([]);

    await toolbar.getByRole("button", { name: "Bold", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(toolbar.getByRole("button", { name: "Italic" })).toBeFocused();
    await panel.getByRole("button", { name: "Markdown source" }).click();
    await expect(toolbar).toHaveCount(0);
    await expect(scroll).toHaveCSS("scroll-padding-block-end", originalPadding);
  }
});

// Browser-only boundary: an external blob module uses the host React tree,
// host styles, focus targets and durable split across a real document reload.
test("installed documents reuse host Markdown, workspace tabs and persisted split", async ({
  page,
  app,
}) => {
  const reader = await installedDocumentReader(page, app);
  const tab = (name) => reader.getByRole("tab", { name, exact: true });
  const draft = (name) =>
    reader.getByRole("textbox", { name: `${name} draft` });
  await expect(tab("Guide")).toHaveAttribute("aria-selected", "true");
  await expect(reader.getByRole("heading", { name: "Guide" })).toBeVisible();
  await expect(
    reader
      .getByRole("tabpanel", { name: "Guide", exact: true })
      .getByText("Tracking image", { exact: true }),
  ).toBeVisible();
  await expect(reader.locator("img")).toHaveCount(0);
  await expect(reader.getByRole("link", { name: "Unsafe" })).toHaveCount(0);
  await expect(
    reader.getByRole("link", { name: "#Alpha", exact: true }),
  ).toBeVisible();
  await expect(
    reader.getByRole("link", { name: "the alpha room" }).locator("strong"),
  ).toHaveText("alpha");
  await draft("Guide").fill("Retain this document");
  await tab("Reference").click();
  await expect(draft("Reference")).toBeFocused();
  await tab("Guide").click();
  await expect(draft("Guide")).toHaveValue("Retain this document");
  await tab("Guide").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab("Reference")).toBeFocused();
  await reader
    .getByRole("button", { name: "Close Reference tab", exact: true })
    .click();
  await expect(tab("Reference")).toHaveCount(0);
  await expect(draft("Guide")).toHaveValue("Retain this document");

  // Native contenteditable, host formatting and the portal's link-dialog focus
  // must work through the external Blob module, not just a type/DOM fixture.
  await reader.getByRole("button", { name: "Edit Guide", exact: true }).click();
  const richEditor = reader.getByRole("textbox", {
    name: "Document body",
    exact: true,
  });
  await richEditor.fill("Changed guide");
  await richEditor.press("ControlOrMeta+a");
  await reader.getByRole("button", { name: "Bold", exact: true }).click();
  await reader
    .getByRole("button", { name: "Markdown source", exact: true })
    .click();
  const markdownSource = reader.getByRole("textbox", {
    name: "Markdown",
    exact: true,
  });
  await expect(markdownSource).toHaveValue("## **Changed guide**");
  await markdownSource.fill("# Source heading\n\nKept literal source");
  await markdownSource.press("ControlOrMeta+Enter");
  await expect(reader.getByRole("status")).toContainText("Saved 1");
  await reader.getByRole("button", { name: "Rich text", exact: true }).click();
  await expect(
    richEditor.getByRole("heading", { name: "Source heading", level: 1 }),
  ).toBeVisible();
  await reader
    .getByRole("button", { name: "Replace document", exact: true })
    .click();
  await expect(richEditor.locator("strong")).toHaveText("replacement");
  await richEditor.press("ControlOrMeta+a");
  await reader.getByRole("button", { name: "Link", exact: true }).click();
  const linkDialog = page.getByRole("dialog", {
    name: "Add link",
    exact: true,
  });
  await linkDialog
    .getByRole("textbox", { name: "URL", exact: true })
    .fill("javascript:alert(1)");
  await linkDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(linkDialog).toContainText(
    "Use an HTTP(S) URL or a valid buzz:// link.",
  );
  const destination = linkDialog.getByRole("combobox", {
    name: "Link destination",
    exact: true,
  });
  await destination.fill("Reference");
  await page
    .getByRole("option", { name: "Reference document", exact: true })
    .click();
  await expect(
    linkDialog.getByRole("textbox", { name: "URL", exact: true }),
  ).toHaveValue("buzz://plugin?id=example.documents&document=reference");
  await linkDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(linkDialog).toBeHidden();
  await expect(richEditor).toBeFocused();
  // Native keyboard edits must preserve the CommonMark structure the host reads,
  // including when the changed text is outside a nested block.
  await reader
    .getByRole("button", { name: "Markdown source", exact: true })
    .click();
  const tableSource = "| Key | Value |\n| :--- | ---: |\n| A \\| B | **12** |";
  const rawTable = "| A | B |\n| - | - |\n| a | b | extra |";
  const quoted = `> First point\n>\n> Second point\n\n${tableSource}\n\n${rawTable}\n\nEnd`;
  await markdownSource.fill(quoted);
  await reader.getByRole("button", { name: "Rich text", exact: true }).click();
  const grid = richEditor.getByRole("table");
  await expect(grid).toHaveCount(1);
  await expect(richEditor).toContainText("| a | b | extra |");
  await expect(grid.getByRole("cell", { name: "A | B" })).toBeVisible();
  await expect(grid.getByRole("cell", { name: "12" })).toHaveCSS(
    "text-align",
    "right",
  );
  await richEditor.evaluate((field) => {
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  });
  await richEditor.press("!");
  await richEditor.press("ControlOrMeta+Enter");
  await expect(reader.getByRole("status")).toContainText("Saved 2");
  await reader.getByRole("button", { name: "Read Guide", exact: true }).click();
  // The shared renderer owns the read-mode wrapper; the hidden editor is its sibling.
  const body = reader
    .getByRole("region", { name: "Document content", exact: true })
    .locator(":scope > div:not([hidden])");
  await expect(body).toHaveCount(1);
  await expect(body.locator(":scope > blockquote p")).toHaveText([
    "First point",
    "Second point",
  ]);
  await expect(body.locator(":scope > p").last()).toHaveText("End!");
  await expect(
    body.getByRole("table").getByRole("cell", { name: "12" }),
  ).toHaveCSS("text-align", "right");
  await reader.getByRole("button", { name: "Edit Guide", exact: true }).click();
  await expect(
    grid.getByRole("cell", { name: "12" }).locator("strong"),
  ).toBeVisible();
  await reader
    .getByRole("button", { name: "Markdown source", exact: true })
    .click();
  await expect(markdownSource).toHaveValue(`${quoted}!`);
  await markdownSource.fill(tableSource);
  await reader.getByRole("button", { name: "Rich text", exact: true }).click();
  await richEditor.evaluate((field) =>
    field.setSelectionRange(field.value.length, field.value.length),
  );
  await richEditor.press("Backspace");
  await expect(grid).toBeVisible();
  await richEditor.evaluate((field) =>
    field.setSelectionRange(field.value.length, field.value.length),
  );
  await richEditor.pressSequentially("Notes");
  await reader
    .getByRole("button", { name: "Markdown source", exact: true })
    .click();
  await expect(markdownSource).toHaveValue(`${tableSource}\n\nNotes`);
  await markdownSource.fill("FirstSecond");
  await reader.getByRole("button", { name: "Rich text", exact: true }).click();
  await richEditor.evaluate((field) => field.setSelectionRange(5, 5));
  await richEditor.press("Enter");
  await reader
    .getByRole("button", { name: "Markdown source", exact: true })
    .click();
  await expect(markdownSource).toHaveValue("First\n\nSecond");
  await reader.getByRole("button", { name: "Rich text", exact: true }).click();
  await richEditor.evaluate((field) => field.setSelectionRange(1, 1));
  await richEditor.press("Shift+Enter");
  await reader
    .getByRole("button", { name: "Markdown source", exact: true })
    .click();
  await expect(markdownSource).toHaveValue("F\\\nirst\n\nSecond");
  await reader.getByRole("button", { name: "Rich text", exact: true }).click();
  await reader.getByRole("button", { name: "Read Guide", exact: true }).click();
  await expect(body.locator(":scope > p")).toHaveCount(2);
  await expect(body.locator(":scope > p br")).toHaveCount(1);

  // Exercise the installed module's browser clipboard handlers in both flavors.
  // DataTransfer stays inside this page; the operating-system clipboard is untouched.
  await reader.getByRole("button", { name: "Edit Guide", exact: true }).click();
  await reader
    .getByRole("button", { name: "Markdown source", exact: true })
    .click();
  const clipboardSource =
    "First\\\nSecond `code`\n\n> Quote first\n>\n> Quote second\n\n- One\n\n- Two";
  await markdownSource.fill(clipboardSource);
  await reader.getByRole("button", { name: "Rich text", exact: true }).click();
  await richEditor.evaluate((field) => {
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  });
  await richEditor.press("!");
  const copied = await richEditor.evaluate((field) => {
    field.focus();
    field.setSelectionRange(0, field.value.length);
    const data = new DataTransfer();
    field.dispatchEvent(
      new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
    return {
      text: data.getData("text/plain"),
      html: data.getData("text/html"),
    };
  });
  expect(copied.html).toContain('data-buzz-copy="document"');
  for (const rich of [true, false]) {
    await richEditor.fill("Paste here");
    await richEditor.evaluate(
      (field, { copied, rich }) => {
        field.focus();
        field.setSelectionRange(0, field.value.length);
        const data = new DataTransfer();
        data.setData("text/plain", copied.text);
        if (rich) data.setData("text/html", copied.html);
        field.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: data,
          }),
        );
      },
      { copied, rich },
    );
    await reader
      .getByRole("button", { name: "Read Guide", exact: true })
      .click();
    await expect(body.locator(":scope > p br")).toHaveCount(1);
    await expect(body.locator(":scope > p code")).toHaveText("code");
    await expect(body.locator(":scope > blockquote p")).toHaveText([
      "Quote first",
      "Quote second",
    ]);
    await expect(body.locator(":scope > ul > li > p")).toHaveText([
      "One",
      "Two!",
    ]);
    await reader
      .getByRole("button", { name: "Edit Guide", exact: true })
      .click();
  }

  await reader
    .getByRole("button", { name: "Markdown source", exact: true })
    .click();
  await markdownSource.fill("");
  await reader.getByRole("button", { name: "Rich text", exact: true }).click();
  await richEditor.pressSequentially("C:" + "\\");
  await richEditor.press("Shift+Enter");
  await richEditor.pressSequentially("next");
  await reader
    .getByRole("button", { name: "Markdown source", exact: true })
    .click();
  await expect(markdownSource).toHaveValue("C:" + "\\".repeat(3) + "\nnext");
  await reader.getByRole("button", { name: "Rich text", exact: true }).click();
  await reader.getByRole("button", { name: "Read Guide", exact: true }).click();
  await expect(body.locator(":scope > p br")).toHaveCount(1);
  await expect(body.locator(":scope > p")).toHaveText(/C:\\\s*next/);

  const handle = reader.getByRole("separator");
  await handle.focus();
  await page.keyboard.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", "320");
  await expect
    .poll(async () => Math.round((await reader.boundingBox()).width))
    .toBe(320);
  await page.reload();
  await openPage(page, "Documents");
  await expect(handle).toHaveAttribute("aria-valuenow", "320");
  await expect
    .poll(async () => Math.round((await reader.boundingBox()).width))
    .toBe(320);
  await handle.dblclick();
  await expect(handle).toHaveAttribute("aria-valuenow", "448");
  // Native focus/scrolling through the installed module needs a browser;
  // the shared Markdown journey owns the theme/width/text-scale matrix.
  const code = body.locator("pre code");
  const precedingLink = reader.getByRole("link", { name: "the alpha room" });
  await precedingLink.focus();
  // The host link opens its keyboard preview before the code's Tab stop.
  await expect(precedingLink).toHaveAttribute("data-popup-open", "");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("link", { name: "Channel preview", exact: true }),
  ).toHaveCount(0);
  await expect(precedingLink).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(code).toBeFocused();
  const initialScroll = await code.evaluate((el) => el.scrollTop);
  await page.keyboard.press("End");
  await expect
    .poll(() => code.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(initialScroll);
  await page.keyboard.press("Tab");
  await expect(code).not.toBeFocused();
  for (const mode of ["Dark", "Light"]) {
    await openSettings(page);
    await selectSettingsSection(page, "Appearance");
    await chooseColorMode(page, mode);
    await closeSettings(page);
    await page.setViewportSize({ width: 480, height: 850 });
    await page.evaluate(
      () => (document.documentElement.style.fontSize = "20px"),
    );
    await expect(tab("Guide")).toBeVisible();
    await expect(draft("Guide")).toBeVisible();
    await reader
      .getByRole("button", { name: "Edit Guide", exact: true })
      .click();
    await expect(richEditor).toBeVisible();
    await expect(
      reader.getByRole("button", { name: "Bold", exact: true }),
    ).toBeVisible();
    const bounds = await reader.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(480);
    await expect(grid).toHaveAttribute("data-overflow", "true");
    const tableBounds = await grid.boundingBox();
    expect(tableBounds.x + tableBounds.width).toBeLessThanOrEqual(
      bounds.x + bounds.width,
    );
    await grid.focus();
    await expect(grid).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() => grid.evaluate((table) => table.scrollLeft))
      .toBeGreaterThan(0);
    await reader
      .getByRole("button", { name: "Read Guide", exact: true })
      .click();
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.evaluate(() =>
      document.documentElement.style.removeProperty("font-size"),
    );
  }
  await reader.getByRole("link", { name: "the alpha room" }).click();
  await expect(page.locator('[data-channel-timeline="alpha"]')).toBeVisible();
});

async function openTableEditor(page, app) {
  const reader = await installedDocumentReader(page, app);
  await reader.getByRole("button", { name: "Edit Guide" }).click();
  return {
    reader,
    rich: reader.getByRole("textbox", { name: "Document body" }),
    source: reader.getByRole("textbox", { name: "Markdown", exact: true }),
    markdown: reader.getByRole("button", { name: "Markdown source" }),
    formatted: reader.getByRole("button", { name: "Rich text", exact: true }),
  };
}

test("document lists reopen with empty items ready for typing", async ({
  page,
  app,
}) => {
  const { reader, rich, source, markdown, formatted } = await openTableEditor(
    page,
    app,
  );
  const read = reader.getByRole("button", { name: "Read Guide", exact: true });
  const edit = reader.getByRole("button", { name: "Edit Guide", exact: true });
  for (const nested of [false, true]) {
    await markdown.click();
    await source.fill("");
    await formatted.click();
    await rich.focus();
    await page.keyboard.type("- First");
    await page.keyboard.press("Enter");
    if (nested) await page.keyboard.press("Tab");

    await rich.press("ControlOrMeta+Enter");
    await expect(reader.getByRole("status")).toHaveText(
      `Saved ${nested ? 2 : 1}`,
    );
    await read.click();
    await edit.click();

    const items = rich.locator(nested ? "ul ul > li" : "ul > li");
    await expect(items).toHaveText(nested ? [""] : ["First", ""]);
    await items
      .last()
      .locator("p")
      .click({ position: { x: 2, y: 4 } });
    await page.keyboard.type("Continued");
    await expect(items).toHaveText(
      nested ? ["Continued"] : ["First", "Continued"],
    );
    if (nested)
      await expect(rich.locator("ul > li > p").first()).toHaveText("First");
  }
});

async function tableClipboard(rich, type, payload = {}) {
  return rich.evaluate(
    (field, { type, text, html, placement }) => {
      if (placement) {
        field.focus();
        const end = field.value.length;
        field.setSelectionRange(placement === "all" ? 0 : end, end);
      }
      const data = new DataTransfer();
      if (html) data.setData("text/html", html);
      if (text) data.setData("text/plain", text);
      field.dispatchEvent(
        new ClipboardEvent(type, {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        }),
      );
      return {
        text: data.getData("text/plain"),
        html: data.getData("text/html"),
      };
    },
    { type, ...payload },
  );
}

test("formatted documents create, reopen, and paste headings", async ({
  page,
  app,
}) => {
  const { reader, rich, source, markdown, formatted } = await openTableEditor(
    page,
    app,
  );
  await markdown.click();
  await source.fill("");
  await formatted.click();
  await rich.focus();
  await page.keyboard.type("## ");
  const heading = rich.locator("h2");
  await expect(heading).toHaveCount(1);
  await rich.press("ControlOrMeta+z");
  await expect(rich.locator("p")).toHaveText("##");
  await rich.press("ControlOrMeta+Shift+z");
  await page.keyboard.type("Typed heading #");
  await expect(heading).toHaveText("Typed heading #");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Following paragraph");
  await expect(rich.locator("p")).toHaveText("Following paragraph");
  await rich.press("ControlOrMeta+Enter");
  await expect(reader.getByRole("status")).toHaveText("Saved 1");
  await reader.getByRole("button", { name: "Read Guide" }).click();
  await reader.getByRole("button", { name: "Edit Guide" }).click();
  await expect(heading).toHaveText("Typed heading #");

  await rich.press("ControlOrMeta+a");
  await tableClipboard(rich, "paste", { text: "### Pasted heading" });
  await expect(rich.locator("h3")).toHaveText("Pasted heading");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("After H3");
  await expect(rich.locator("p")).toHaveText("After H3");
});

async function clickParagraphStart(paragraph) {
  await paragraph.click({ position: { x: 1, y: 4 } });
  await expect
    .poll(() =>
      paragraph.evaluate((element) => {
        const selection = element.ownerDocument.getSelection();
        return (
          selection?.isCollapsed &&
          selection.anchorOffset === 0 &&
          (selection.anchorNode === element ||
            selection.anchorNode === element.firstChild)
        );
      }),
    )
    .toBe(true);
}

test("joining text into a single-line heading preserves the following lines", async ({
  page,
  app,
}) => {
  const { reader, rich, source, markdown, formatted } = await openTableEditor(
    page,
    app,
  );
  await markdown.click();
  await source.fill("### Head\n\na\\\nb\\\nc");
  await formatted.click();
  const heading = rich.getByRole("heading", { level: 3 });
  const paragraph = rich.locator("p");
  await clickParagraphStart(paragraph);
  await page.keyboard.press("Backspace");
  await expect(heading).toHaveText("Heada");
  await expect(paragraph).toHaveText("bc");
  await expect(paragraph.locator("br")).toHaveCount(1);
  await rich.press("ControlOrMeta+z");
  await expect(heading).toHaveText("Head");
  await expect(paragraph.locator("br")).toHaveCount(2);
  await rich.press("ControlOrMeta+Shift+z");
  await expect(heading).toHaveText("Heada");
  await rich.press("ControlOrMeta+Enter");
  await expect(reader.getByRole("status")).toHaveText("Saved 1");
  await reader.getByRole("button", { name: "Read Guide" }).click();
  await reader.getByRole("button", { name: "Edit Guide" }).click();
  await expect(heading).toHaveText("Heada");
  await expect(paragraph).toHaveText("bc");
  await expect(paragraph.locator("br")).toHaveCount(1);
});

test("joined list items retain paragraphs after nested blocks on reopen", async ({
  page,
  app,
}) => {
  const { reader, rich, source, markdown, formatted } = await openTableEditor(
    page,
    app,
  );
  for (const [nested, content] of [
    ["ul", "- Nested"],
    ["blockquote", "> Nested"],
  ]) {
    await markdown.click();
    await source.fill(`- First\n  ${content}\n- Second`);
    await formatted.click();
    const items = rich.locator("ul").first().locator(":scope > li");
    await clickParagraphStart(items.last().locator("p"));
    await page.keyboard.press("Backspace");
    await expect(items).toHaveCount(1);
    await expect(items.locator(":scope > p")).toHaveText(["First", "Second"]);
    await rich.press("ControlOrMeta+Enter");
    await expect(reader.getByRole("status")).toHaveText(
      nested === "ul" ? "Saved 1" : "Saved 2",
    );
    await reader.getByRole("button", { name: "Read Guide" }).click();
    await reader.getByRole("button", { name: "Edit Guide" }).click();
    await expect(items.locator(":scope > p")).toHaveText(["First", "Second"]);
    await expect(items.locator(`:scope > ${nested}`)).toHaveText("Nested");
  }
});

test("a trailing hard break preserves heading levels on reopen", async ({
  page,
  app,
}) => {
  const { reader, rich, source, markdown, formatted } = await openTableEditor(
    page,
    app,
  );
  for (const level of [1, 2]) {
    await markdown.click();
    await source.fill(`${"#".repeat(level)} Head`);
    await formatted.click();
    const heading = rich.getByRole("heading", { level });
    await rich.focus();
    await heading.evaluate((element) => {
      element.ownerDocument
        .getSelection()
        ?.collapse(element, element.childNodes.length);
    });
    await page.keyboard.press("Shift+Enter");
    await expect(heading.locator("br").first()).toBeAttached();
    await rich.press("ControlOrMeta+Enter");
    await expect(reader.getByRole("status")).toHaveText(`Saved ${level}`);
    await reader.getByRole("button", { name: "Read Guide" }).click();
    await reader.getByRole("button", { name: "Edit Guide" }).click();
    await expect(heading).toHaveText("Head");
  }
});

const smallTable = "| Cell | Value |\n| --- | --- |\n| cellword | 2 |";

async function selectCellText(page, cell) {
  const points = await cell.evaluate((element) => {
    const range = document.createRange();
    range.setStart(element.firstChild, 0);
    range.setEnd(element.firstChild, 4);
    const { left, right, y, height } = range.getBoundingClientRect();
    return { left: left + 0.5, right: right - 0.5, y: y + height / 2 };
  });
  await page.mouse.move(points.left, points.y);
  await page.mouse.down();
  await page.mouse.move(points.right, points.y, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => getSelection()?.toString()))
    .toBe("cell");
}

test("document table selection keeps clipboard and deletion scoped", async ({
  page,
  app,
}) => {
  const { reader, rich, source, markdown, formatted } = await openTableEditor(
    page,
    app,
  );
  const original = `Before\n\n${smallTable}\n\nAfter`;
  await markdown.click();
  await source.fill(original);
  await formatted.click();

  const cell = rich.getByRole("cell", { name: "cellword" });
  for (const type of ["copy", "cut"]) {
    await rich.evaluate((field, type) => {
      field.focus();
      field.setSelectionRange(0, type === "cut" ? "Before".length : 0);
    }, type);
    await selectCellText(page, cell);
    const { text } = await tableClipboard(rich, type);
    expect.soft(text).toBe("cell");
  }
  await markdown.click();
  await expect.soft(source).toHaveValue(original);
  await source.fill(original);
  await formatted.click();
  await rich.evaluate((field) => {
    field.focus();
    const start = field.value.lastIndexOf("After");
    field.setSelectionRange(start, start);
  });
  await rich.press("Backspace");
  await expect(rich.getByRole("table")).toBeVisible();
  await rich.press("Backspace");
  await rich.press("ControlOrMeta+Enter");
  await expect(reader.getByRole("status")).toContainText("Saved 1");
  await reader.getByRole("button", { name: "Read Guide" }).click();
  await reader.getByRole("button", { name: "Edit Guide" }).click();
  await markdown.click();
  await expect(source).toHaveValue("Before\n\nAfter");
});

test("document table text keeps toolbar, Backspace and history scoped", async ({
  page,
  app,
}) => {
  const { reader, rich, source, markdown, formatted } = await openTableEditor(
    page,
    app,
  );
  const original = `Before\n\n${smallTable}\n\nAfter`;
  await markdown.click();
  await source.fill(original);
  await formatted.click();
  const grid = rich.getByRole("table");
  const selectGridText = async () => {
    await grid.evaluate((table) => {
      table.focus();
      const text = table.querySelector("tbody td")?.firstChild;
      if (!text) throw new Error("Missing cell text");
      document.getSelection()?.setBaseAndExtent(text, 0, text, 4);
    });
    await expect(grid).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => getSelection()?.toString()))
      .toBe("cell");
  };
  for (const name of ["Bold", "Quote", "Link"]) {
    await rich.evaluate((field) => {
      field.focus();
      field.setSelectionRange(0, "Before".length);
    });
    await selectGridText();
    await reader.getByRole("button", { name, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect.soft(dialog).toHaveCount(0, { timeout: 1000 });
    if (await dialog.isVisible()) await page.keyboard.press("Escape");
  }
  await markdown.click();
  await expect.soft(source).toHaveValue(original, { timeout: 1000 });
  await source.fill(original);
  await formatted.click();
  await selectGridText();
  await page.evaluate(() => {
    document.addEventListener(
      "keydown",
      (event) => {
        document.documentElement.dataset.tableBackspace = String(
          event.defaultPrevented,
        );
      },
      { once: true },
    );
  });
  await page.keyboard.press("Backspace");
  await expect
    .soft(page.locator("html"))
    .toHaveAttribute("data-table-backspace", "true");
  await expect(reader).toBeVisible();

  await rich.evaluate((field) => {
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  });
  await rich.pressSequentially("Z");
  await expect(rich).toContainText("AfterZ");
  await page.evaluate(() => {
    document.addEventListener("keydown", (event) => {
      if (event.key.toLowerCase() !== "z" || !(event.metaKey || event.ctrlKey))
        return;
      const direction = event.shiftKey ? "redo" : "undo";
      document.documentElement.dataset.tableHistory = `${direction}:${event.defaultPrevented}`;
    });
  });
  const pageRoot = page.locator("html");
  await selectGridText();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(pageRoot).toHaveAttribute("data-table-history", "undo:true");
  await expect(rich).toContainText("After");
  await expect(rich).not.toContainText("AfterZ");
  await selectGridText();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(pageRoot).toHaveAttribute("data-table-history", "redo:true");
  await expect(rich).toContainText("AfterZ");
  await markdown.click();
  await expect(source).toHaveValue(`${original}Z`);
});

test("toolbar wrapping keeps table Markdown source through reopen", async ({
  page,
  app,
}) => {
  const { reader, rich, source, markdown, formatted } = await openTableEditor(
    page,
    app,
  );
  for (const [name, marker] of [
    ["Quote", "> Before"],
    ["Bullet list", "- Before"],
    ["Ordered list", "1. Before"],
  ]) {
    await markdown.click();
    await source.fill(`Before\n\n${smallTable}\n\nAfter`);
    await formatted.click();
    await rich.press("ControlOrMeta+a");
    await reader.getByRole("button", { name, exact: true }).click();
    await expect
      .soft(rich.getByRole("table"))
      .toHaveCount(0, { timeout: 1000 });
    await reader.getByRole("button", { name: "Read Guide" }).click();
    await reader.getByRole("button", { name: "Edit Guide" }).click();
    await expect(rich.getByRole("table")).toHaveCount(0);
    await markdown.click();
    const saved = await source.inputValue();
    expect(saved).toContain(marker);
    expect(saved).toContain("| cellword | 2 |");
    expect(saved).toContain("After");
    await formatted.click();
  }
});

test("nested document table paste stays source through save and reopen", async ({
  page,
  app,
}) => {
  const { reader, rich, source, markdown, formatted } = await openTableEditor(
    page,
    app,
  );
  await markdown.click();
  await source.fill(smallTable);
  await formatted.click();
  const { html } = await tableClipboard(rich, "copy", { placement: "all" });
  expect(html).toContain('data-buzz-copy="document"');
  for (const [index, prefix, htmlPaste] of [
    [1, "- ", ""],
    [2, "> ", html],
  ]) {
    await markdown.click();
    await source.fill(`${prefix}Note`);
    await formatted.click();
    await tableClipboard(rich, "paste", {
      placement: "end",
      ...(htmlPaste ? { html: htmlPaste } : { text: smallTable }),
    });
    const marker = prefix === "> " ? "> " : "  ";
    const expected =
      prefix +
      "Note" +
      (prefix === "> " ? "\n>\n" : "\n") +
      smallTable
        .split("\n")
        .map((line) => marker + line)
        .join("\n");
    await expect
      .soft(rich.getByRole("table"))
      .toHaveCount(0, { timeout: 1000 });
    await rich.press("ControlOrMeta+Enter");
    await expect(reader.getByRole("status")).toContainText(`Saved ${index}`);
    await reader.getByRole("button", { name: "Read Guide" }).click();
    await reader.getByRole("button", { name: "Edit Guide" }).click();
    await expect(rich.getByRole("table")).toHaveCount(0);
    await markdown.click();
    await expect(source).toHaveValue(expected);
    await formatted.click();
  }
});

test("document table paste observes the combined cell budget", async ({
  page,
  app,
}) => {
  const { rich, source, markdown, formatted } = await openTableEditor(
    page,
    app,
  );
  // Ten columns and 501 rows per table, with the reader's GFM padding.
  const table = [
    `|${" Header |".repeat(10)}`,
    `|${" --- |".repeat(10)}`,
    ...Array(500).fill("| row value |"),
  ].join("\n");
  await markdown.click();
  await source.fill(table);
  await formatted.click();
  await expect(rich.getByRole("table")).toHaveCount(1);
  await tableClipboard(rich, "paste", { placement: "end", text: table });
  await expect(rich.getByRole("table")).toHaveCount(0);
  await markdown.click();
  await expect(source).toHaveValue(`${table}\n\n${table}`);
});
