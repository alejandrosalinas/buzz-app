import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const build = read("src-tauri/build.rs");
const commandList = build.match(
  /AppManifest::new\(\)\.commands\(&\[([\s\S]*?)\]/,
)?.[1];
assert.ok(commandList, "Tauri application command manifest must be found");
const commands = new Set(
  [...commandList.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]),
);
const { permissions } = JSON.parse(read("src-tauri/capabilities/default.json"));

// Commands deliberately granted only to a narrower window capability.
const widget = JSON.parse(read("src-tauri/capabilities/compute-widget.json"));
const huddle = JSON.parse(read("src-tauri/capabilities/huddle.json"));
const windowScoped = new Map([
  ["mesh_compute_widget_status", widget],
  ["huddle_window_watch", huddle],
  ["huddle_window_action", huddle],
]);

function* sources(directory) {
  for (const entry of readdirSync(new URL(directory, root), {
    withFileTypes: true,
  })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(path) && !/\.(test|spec)\./.test(path)) yield path;
  }
}

// Literal calls cover the Mesh plugin and native adapters. Dynamic wrappers
// remain covered by their behavior tests; this is not a runtime ACL evaluator.
test("literal frontend IPC commands are declared and allowed by the main capability", () => {
  const found = new Set();
  for (const path of sources("src")) {
    const source = read(path);
    if (!source.includes('"@tauri-apps/api/core"')) continue;
    for (const [, command] of source.matchAll(
      /\binvoke(?:<[^;]*?>)?\(\s*["']([a-z_]+)["']/g,
    )) {
      found.add(command);
      assert.ok(
        commands.has(command),
        `${path}: ${command} missing from AppManifest`,
      );
      const allowedBy = windowScoped.get(command)?.permissions ?? permissions;
      assert.ok(
        allowedBy.includes(`allow-${command.replaceAll("_", "-")}`),
        `${path}: ${command} missing from its capability`,
      );
    }
  }
  // Prevent accidental loss of coverage if the scanner stops matching Mesh.
  for (const command of [
    "mesh_compute_catalog",
    "mesh_compute_share",
    "mesh_compute_select",
    "mesh_compute_release",
    "mesh_compute_disarm",
    "mesh_compute_status",
  ]) {
    assert.ok(found.has(command), `scanner must find ${command}`);
  }
});

test("every declared app command has a main-window permission, including host stop", () => {
  for (const command of commands) {
    const scoped = windowScoped.get(command);
    if (scoped) {
      const allow = `allow-${command.replaceAll("_", "-")}`;
      assert.ok(
        scoped.permissions.includes(allow),
        `${command} missing from ${scoped.identifier}`,
      );
      assert.ok(
        !permissions.includes(allow),
        `${command} must stay out of main capability`,
      );
      continue;
    }
    assert.ok(
      permissions.includes(`allow-${command.replaceAll("_", "-")}`),
      `${command} missing from main capability`,
    );
  }
});

// The prefix router owns every Mesh command. In particular, status/stop/widget
// calls must not be swallowed by the general handler.
test("Mesh prefix dispatch includes every declared Mesh command", () => {
  const source = read("src-tauri/src/lib.rs");
  const handler = read("src-tauri/src/mesh_compute.rs").match(
    /fn commands\(\)[\s\S]*?tauri::generate_handler!\[([\s\S]*?)\]/,
  )?.[1];
  assert.ok(handler, "Mesh native handler must exist");
  const registered = new Set(handler.match(/mesh_compute_[a-z_]+/g));
  const declared = new Set(
    [...commands].filter((name) => name.startsWith("mesh_compute_")),
  );
  assert.deepEqual(registered, declared);
  assert.match(
    source,
    /let mesh_commands = mesh_compute::commands\(\);[\s\S]*?if request\.message\.command\(\)\.starts_with\("mesh_compute_"\)/,
  );
});
