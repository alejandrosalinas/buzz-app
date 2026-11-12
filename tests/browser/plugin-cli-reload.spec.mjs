import { test, expect } from "./playwright-test.mjs";
import react from "@vitejs/plugin-react";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeFixture } from "./native-fixture.mjs";
import { run } from "./run-command.mjs";
import { createServer } from "./vite-server.mjs";
import { signPackage } from "../fixtures/plugin-release.mjs";

// Proves the real CLI -> native catalog -> browser module replacement boundary.
test("signature enforcement applies signed CLI updates and withdraws an unsigned installed plugin", async ({
  page,
}) => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const temp = await mkdtemp(join(tmpdir(), "buzz-cli-reload-"));
  const previousPolicy = process.env.BUZZ_REQUIRE_PLUGIN_SIGNATURES;
  let server;
  try {
    // The CLI and catalog bridge must use the same opt-in launch policy.
    process.env.BUZZ_REQUIRE_PLUGIN_SIGNATURES = "1";
    const bridge = nativeFixture();
    const cli = nativeFixture("buzzodz");
    const home = join(temp, "home");
    const source = join(temp, "dist");
    await mkdir(source);
    await writeFile(
      join(source, "manifest.json"),
      JSON.stringify({
        id: "test.reload",
        name: "Reload proof",
        apiVersion: 1,
      }),
    );
    const code = (
      label,
    ) => `export const inject = ['pages']; export function apply(ctx) {
      ctx.pages.register({id: 'main', title: '${label}', primary: true, component: () => null});
    }`;
    await writeFile(join(source, "plugin.js"), code("Before reload"));
    await signPackage(source);
    const command = (...args) =>
      run(cli, ["--home", home, "--profile", "proof", "plugin", ...args]);
    command("install", source);
    command("enable", "test.reload");
    server = await createServer({
      root,
      configFile: false,
      envFile: false,
      plugins: [
        react(),
        {
          name: "cli-reload-native-catalog",
          configureServer(server) {
            server.middlewares.use("/__proof", async (req, res) => {
              try {
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                const body = chunks.length
                  ? JSON.parse(Buffer.concat(chunks).toString())
                  : {};
                const args =
                  req.url === "/catalog"
                    ? ["catalog"]
                    : ["module", body.id, body.revision];
                res.setHeader("content-type", "application/json");
                res.end(run(bridge, [home, ...args]));
              } catch (error) {
                res.statusCode = 500;
                res.end(String(error));
              }
            });
          },
        },
      ],
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/conversation.html`,
    );
    const navigation = page.getByRole("navigation", { name: "Proof pages" });
    await expect(
      navigation.getByRole("button", { name: "Before reload", exact: true }),
    ).toBeVisible();
    // Change the persisted signature without changing the enabled flag or revision.
    // Atomic replacement avoids exposing partially written JSON to catalog polling.
    const registryPath = join(home, "profiles/proof/registry.json");
    const signedRegistry = await readFile(registryPath, "utf8");
    const unsignedRegistry = JSON.parse(signedRegistry);
    delete unsignedRegistry.installed["test.reload"].currentSignature;
    const replaceRegistry = async (bytes) => {
      await writeFile(`${registryPath}.fixture`, bytes);
      await rename(`${registryPath}.fixture`, registryPath);
    };
    await replaceRegistry(JSON.stringify(unsignedRegistry));
    await expect(
      navigation.getByRole("button", { name: "Before reload", exact: true }),
    ).toHaveCount(0);
    const rejected = JSON.parse(
      run(bridge, [home, "catalog"]),
    ).catalog.plugins.find((plugin) => plugin.manifest.id === "test.reload");
    expect(rejected.enabled).toBe(true);
    expect(rejected.error).toContain(
      "External plugins require a signed release",
    );
    await replaceRegistry(signedRegistry);
    await expect(
      navigation.getByRole("button", { name: "Before reload", exact: true }),
    ).toBeVisible();
    await writeFile(join(source, "plugin.js"), code("After reload"));
    await signPackage(source);
    expect(command("reload", "test.reload")).toContain("Reloaded test.reload");
    await expect(
      navigation.getByRole("button", { name: "After reload", exact: true }),
    ).toBeVisible();
    await expect(
      navigation.getByRole("button", { name: "Before reload", exact: true }),
    ).toHaveCount(0);
    expect(command("list")).toMatch(/test.reload\s+enabled/);
    await writeFile(
      join(source, "manifest.json"),
      JSON.stringify({
        id: "test.reload",
        name: "Reload proof",
        apiVersion: 1,
        host: { processes: [{ id: "extra", program: "echo" }] },
      }),
    );
    await writeFile(join(source, "plugin.js"), code("After access change"));
    await signPackage(source);
    expect(command("reload", "test.reload")).toContain("Updated host access");
    await expect(
      navigation.getByRole("button", {
        name: "After access change",
        exact: true,
      }),
    ).toBeVisible();
    command("disable", "test.reload");
    await expect(
      navigation.getByRole("button", {
        name: "After access change",
        exact: true,
      }),
    ).toHaveCount(0);
  } finally {
    await server?.close();
    if (previousPolicy === undefined)
      delete process.env.BUZZ_REQUIRE_PLUGIN_SIGNATURES;
    else process.env.BUZZ_REQUIRE_PLUGIN_SIGNATURES = previousPolicy;
    await rm(temp, { recursive: true, force: true });
  }
});
