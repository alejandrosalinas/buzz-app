import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSync } from "rolldown/utils";

const root = fileURLToPath(new URL("../../", import.meta.url));
const gateway = "src/shared/design-system/icons/";
const approved = new Set(["@tabler/icons-react", "@tabler/icons"]);
// A closed policy needs an explicit non-icon side as well as approved icon catalogs.
// Version changes remain ordinary; adding a package requires classifying it here.
const nonIconDependencies = new Set([
  "@base-ui/react",
  "@biomejs/biome",
  "@buzz/author",
  "@deepseek-ai/cordis",
  "@dnd-kit/core", // Pointer drag and drop for sidebar channel moves.
  "@earendil-works/chord", // The Pi host's packages, which pi.sh installs.
  "@earendil-works/pi-ai",
  "@earendil-works/pi-durable",
  "@earendil-works/pi-schema",
  "@emoji-mart/data",
  "@fontsource-variable/inter",
  "@fontsource/jetbrains-mono",
  "@hypothesi/tauri-mcp-server", // Native MCP client (docs/native-mcp.md).
  "@jsquash/webp", // Lossless media encoder, not an icon catalog.
  "@modelcontextprotocol/server", // The standalone Buzz MCP server.
  "@noble/curves",
  "@playwright/test",
  "@pydantic/genai-prices", // LLM price data for Usage estimates.
  "@tailwindcss/postcss",
  "@tanstack/react-router",
  "@tauri-apps/api",
  "@tauri-apps/cli",
  "@tauri-apps/plugin-updater",
  "@testing-library/dom",
  "@testing-library/jest-dom",
  "@testing-library/react",
  "@testing-library/user-event",
  "@types/d3-scale",
  "@types/mdast",
  "@types/node",
  "@types/react",
  "@types/react-dom",
  "@vitejs/plugin-react",
  "@xterm/addon-fit",
  "@xterm/xterm",
  "blurhash",
  "consola", // Runtime logging, not an icon catalog.
  "d3-scale", // Chart scales and ticks; marks are Buzz-rendered SVG.
  "diff", // Text line diffs for Canvas history, not an icon library.
  "dockview-react",
  "echarts", // Chart marks; not an icon library.
  "emoji-mart",
  "flexlayout-react",
  "jsdom",
  "mdast", // Type-only module supplied by @types/mdast.
  "mdast-util-from-markdown",
  "mdast-util-gfm-strikethrough",
  "mdast-util-gfm-table",
  "mdast-util-to-markdown",
  "micromark-extension-gfm-strikethrough",
  "micromark-extension-gfm-table",
  "motion",
  "nostr-tools",
  "pele",
  "postcss",
  "proper-lockfile", // The Pi host's lock on each agent's storage.
  "prosemirror-commands",
  "prosemirror-history",
  "prosemirror-model",
  "prosemirror-schema-list",
  "prosemirror-state",
  "prosemirror-view",
  "react",
  "react-day-picker", // Calendar behavior; navigation icons use our Tabler gateway.
  "react-diff-view", // Patch tables/parser, not an icon library.
  "react-dom",
  "react-markdown",
  "remark-breaks",
  "remark-gfm",
  "rolldown",
  "sonner", // Headless toast behavior; Buzz supplies controls and Tabler icons.
  "tailwindcss",
  "typescript",
  "undici",
  "virtua",
  "vite",
  "vitest",
  "ws", // The native MCP client's loopback relay.
  "yaml",
]);
const allowedDependencies = new Set([...approved, ...nonIconDependencies]);
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const packageName = (specifier) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
export function checkIconManifest(manifest) {
  return dependencyFields
    .flatMap((field) => Object.entries(manifest[field] ?? {}))
    .flatMap(([name, version]) => {
      const alias = version.startsWith("npm:")
        ? packageName(version.slice(4).replace(/@[^@]*$/, ""))
        : undefined;
      const target = alias ?? packageName(name);
      if (allowedDependencies.has(name) && target === name) return [];
      if (!alias && nonIconDependencies.has(target)) return [];
      return [
        `Unclassified dependency: ${name}. Approve non-icon packages explicitly; use only Tabler for icons.`,
      ];
    });
}

// Reuse the build tool's syntax parser so JSX, regexes and template text are
// not mistaken for imports, and expressions inside templates remain visible.
export function checkIconSource(path, source) {
  const parsed = parseSync(path, source);
  if (parsed.errors.length)
    return parsed.errors.map(
      (error) => `Cannot inspect icon imports: ${error.message}`,
    );
  const errors = [];
  const inside = path.startsWith(gateway);
  const literal = (node) =>
    node?.type === "Literal"
      ? node.value
      : node?.type === "TemplateLiteral" && node.expressions.length === 0
        ? node.quasis[0].value.cooked
        : undefined;
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (inside && node.type === "ExportAllDeclaration")
      errors.push("Use explicit named icon exports, not wildcard exports.");
    let target;
    if (
      [
        "ImportDeclaration",
        "ExportNamedDeclaration",
        "ExportAllDeclaration",
        "ImportExpression",
      ].includes(node.type)
    )
      target = node.source;
    else if (node.type === "TSExternalModuleReference")
      target = node.expression;
    else if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "require"
    )
      target = node.arguments[0];
    const specifier = literal(target);
    const dependency =
      typeof specifier === "string" ? packageName(specifier) : undefined;
    if (
      dependency !== undefined &&
      !specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      !specifier.startsWith("node:") &&
      !specifier.startsWith("#")
    ) {
      if (!allowedDependencies.has(dependency))
        errors.push(
          `Use shared/design-system/icons instead of unclassified external dependency ${specifier}.`,
        );
      else if (approved.has(dependency)) {
        if (!inside)
          errors.push(
            `Use shared/design-system/icons instead of ${specifier}.`,
          );
        else if (
          !(
            node.type === "ImportDeclaration" &&
            node.importKind === "type" &&
            specifier === "@tabler/icons-react"
          ) &&
          !/^@tabler\/(?:icons-react\/dist\/esm\/icons\/Icon[A-Z][A-Za-z0-9]*\.mjs|icons\/(?:outline|filled)\/[a-z0-9-]+\.svg\?raw)$/.test(
            specifier,
          )
        )
          errors.push(
            `Import individual Tabler modules/assets, not the full catalog: ${specifier}`,
          );
      } else if (inside && dependency !== "react")
        errors.push(`The icon gateway cannot depend on ${specifier}.`);
    }
    for (const value of Object.values(node))
      if (value && typeof value === "object") visit(value);
  }
  visit(parsed.program);
  return errors;
}
// Check the given repository-relative paths, or every tracked/untracked file.
export function checkIcons(selected = []) {
  const paths = selected.length
    ? selected
    : execFileSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { cwd: root, encoding: "utf8" },
      )
        .split("\0")
        .filter(Boolean);
  const errors = [];
  for (const path of new Set(paths)) {
    if (!existsSync(`${root}${path}`)) continue;
    if (path === "package.json" || path.endsWith("/package.json"))
      errors.push(
        ...checkIconManifest(
          JSON.parse(readFileSync(`${root}${path}`, "utf8")),
        ).map((error) => `${path}: ${error}`),
      );
    if (/\.[cm]?[jt]sx?$/.test(path))
      errors.push(
        ...checkIconSource(path, readFileSync(`${root}${path}`, "utf8")).map(
          (error) => `${path}: ${error}`,
        ),
      );
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Icon dependencies and source import boundary checked.");
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  checkIcons(process.argv.slice(2));
