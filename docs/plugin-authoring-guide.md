# Writing a Buzz plugin

A plugin is a folder with `manifest.json` and one self-contained ES module `plugin.js` that exports `inject` (array of service names) and `apply(ctx)`. It is trusted, unsandboxed code that runs inside the Buzz desktop app. `apply` must finish activating within 10 seconds. API v1 allows one file: no CSS, no assets, no runtime imports (React comes from `ctx.react`; JSX runtime and bundler chunks do not work). The host loads the module from a blob URL, so any `import` of a bare or relative path fails.

## Workflow

1. Write a small first version as plain JS in a folder in your workspace: `React.createElement` via `ctx.react`, no build step. TypeScript/JSX is optional and only worth it if you set up your own bundler that emits a single `plugin.js` with classic JSX and no runtime imports. `buzzodz plugin init` exists only with a buzz-app checkout.
2. First install needs the owner. Ask them to open **Settings → Plugins → Manage plugins**, choose **Add**, then **Browse** under Add from folder, pick your folder, review the host access shown and select **Install plugin**. It must be **Browse**: a dragged-in folder is copied, so it has no folder to reload. New plugins are enabled by default (the review has an opt-out).
3. After that, edit the files in the same folder and call the `plugin_reload` tool with the manifest id. It briefly stops the plugin, loads the new files, waits for activation and, if the new code fails to start, restores the revision that was running. Read its `application` result (`applied` | `saved` | `failed`, with `nextStep`) instead of guessing. Call `plugin_status` (optionally with `id`) to see state, errors and the pages, panels, sidebar sections and agent tools it registered. Reload also applies `name`, `description` and `discovery` changes; a changed `id` is refused (install it as a new plugin).
4. If you change `manifest.host` (host access), reload refuses. The owner must review the change via the plugin's **Update** in Settings → Plugins.
5. Verify what the user will see. Keep the first version small, then refine.

## Minimal template (a primary page)

`manifest.json`
```json
{ "id": "example.hello", "name": "Hello", "apiVersion": 1, "description": "Say hello from a plugin page." }
```

`plugin.js`
```js
export const inject = ["react", "pages"];

export function apply(ctx) {
  const React = ctx.react;
  ctx.pages.register({
    id: "main",
    title: "Hello",
    primary: true, // adds a navigation entry; without it the page is search/deep-link only
    component: function Hello() {
      const [count, setCount] = React.useState(0);
      return React.createElement(
        "section",
        { className: "ui-card", style: { padding: "var(--space-panel-inset)" } },
        React.createElement("h1", null, "Hello"),
        React.createElement("button", { type: "button", onClick: () => setCount(count + 1) }, `Clicked ${count} times`),
      );
    },
  });
}
```

## Contract rules

- Manifest keys: `id`, `name`, `apiVersion` (must be `1`), optional `description` (1-280 bytes), `discovery` (`category` slug, up to 16 `tags`), `host`. Other top-level keys, and unknown keys inside `host`, are rejected.
- Plugin `id`: starts with a lowercase letter, then lowercase letters, digits, `.` and `-` only, at most 80 bytes, no empty segments (no `..`, `-.`, trailing `.`). No underscores. Ids of bundled plugins are reserved. `name`: 1-80 bytes. Updates match on `id`.
- Contribution ids (page, panel, shortcut, settings card, sidebar section and its actions): `/^[a-z0-9][a-z0-9._-]*$/`, unique within the plugin. Hosts add the plugin identity, so ids are local.
- Module evaluation must be pure: no work at top level. Do everything in `apply`. Enabled plugins activate even if their page is never opened.
- Declare every service you use in `inject` (for example `["react", "pages", "shortcuts"]`). `apply` runs only once all are available. `sidebarSections` and `pluginInstaller` are optional services: read them with `ctx.reflect.get("name")` (returns `undefined` on older hosts) instead of listing them in `inject`.
- Own every timer, listener, subscription or process with `ctx.effect(() => { start(); return () => stop(); })`. Cleanup runs on disable, replacement and app teardown. React effects inside components clean up when the page unmounts.
- Everything you register is owned by the plugin and removed when it is disabled or replaced. A `register` call that throws on invalid fields fails activation; the error appears in Settings and `plugin_status`.
- React state resets when the revision changes (a reload remounts the selected page). The module is evaluated once per revision per app session, so module-level variables survive a disable and enable of the same revision. There is no key-value storage API; `ctx.artifactStorage` is a structured IndexedDB store for synced artifacts.
- Page and panel components render in React error boundaries, but loops and global side effects are not contained.

## Extension points

| Inject | Registers | Call and required fields |
| --- | --- | --- |
| `pages` | A page | `ctx.pages.register({ id, title, component, primary?, placement?, icon?, badge?, sidebar?, companion?, layout? })`. `id` must match the id pattern, `title` non-empty, `component` a function. `placement`: `"sidebar"` (default) or `"dock"` (only for `primary` pages; `"topbar"` and `"toolbar"` are accepted aliases for `"dock"`). `icon`: `data:image/...` URL. `badge`: component shown beside the nav entry. `sidebar`: component receiving `{ target, children }` that replaces the conversation sidebar (wrap content in `className="shell-sidebar-default"`). `layout`: `"document"` or `"workspace"`. |
| `panels` | A panel for a link/target string | `ctx.panels.register({ id, title, matches(target) => boolean, component, order?, launcher?, channelLauncher?, channelPlacement?, keepOpen? })`. `component` receives `{ target, close, context?, channelContext? }`. `launcher: { icon: string, target: string }` adds a top-bar button (use `matches: () => false` for launcher-only). `channelLauncher` is a component for the channel header (`channelPlacement`: `"bottom"` default, `"side"`, `"tab"`). |
| `settingsCards` | A Settings destination | `ctx.settingsCards.register({ id, title, component, group?, personal? })`. `component` receives `{ active(), community? }`. Omit `icon` (it is a host icon component). The host supplies navigation and the content column, not a heading. |
| `sidebarSections` (optional) | A section in the Team sidebar | `ctx.reflect.get("sidebarSections")?.register({ version: 1, id, title, icon, rows: { snapshot, subscribe }, select, actions? })`. `snapshot()` returns a stable array of `{ id, label, icon?, badge?, count?, status? }` until data changes, then notify subscribers. `select(row)` returns an open target such as `{ version: 1, kind: "home" }`. Actions: `{ id, label, icon: ReactElement, onSelect }`. |
| `conversation` | Composer/message UI | `registerAccessory({ id, title, component, order?, placement? })` (read-only UI above the composer; props `{ session, scope, channelId, threadRootId?, canOpen, open }`; `placement`: `"composer"`, `"message"`, `"response"`). `registerMessage({ id, title, matches(message), component })`, `registerMessageAction({ id, title, matches(message, session), component })`, `registerLink({ id, title, matches(url), component })`, `registerTool({ id, title, component })`. |
| `agents` | Tools and hooks for agents | `ctx.agents.addTool({ name, description, inputSchema, call })`. `name` matches `/^[a-z][a-z0-9_]{0,63}$/`, is unique across plugins and not a Buzz tool name (prefix it with your plugin: `notes_get`). `inputSchema` is a JSON-serializable object with `type: "object"`. `async call(client, context, args)` resolves to a string (or `{ data, type, text? }`) and runs as the agent; a throw is shown to the agent as a tool error. Changing a tool's name, description or schema restarts some agent sessions, so edit deliberately. `ctx.agents.registerHook({ id, harness, event, run })` needs `host.agentHooks`. `ctx.agents.wake(agentKey, { channel, root?, text })` wakes a local agent (`root` is a 64-hex event id). |
| `shortcuts` | In-app key bindings | `ctx.shortcuts.register({ id, title, binding, run, when?, order?, allowInEditable?, allowInModal?, repeat? })`. `binding` is `{ key, mod?, shift?, alt?, ctrl? }` or an array; `mod` is Command on macOS, Control elsewhere. `key` is the logical key, case-insensitive (Space is `" "`). Skipped in text fields and modals unless opted in. |
| `navigation` | Open destinations | `await ctx.navigation.open(target)` returns `{ status: "opened" \| "failed" \| "superseded" \| "cancelled" }`. Targets: `{ version: 1, kind: "plugin", pluginId, pageId?, params? }`, `{ version: 1, kind: "home" }`, `{ version: 1, kind: "settings", section? }`. |
| `communityJoin` (optional) | Join a community the person chose in your UI | `ctx.reflect.get("communityJoin")?.open(address)` with a `wss://` or `https://` community address, for example one your plugin just created. It opens the app's join dialog, which connects at once; the person still completes admission and the profile step there, and nothing is saved before they do. An address already saved just selects that community. It returns `false` when the address is not a community origin (for example it has a path or credentials) or no identity is ready to join with (hand the address off another way), otherwise `true`; it reports no completion. Call it only from a live, user-initiated action. |
| `notifications` | OS notification category | `const { submit } = ctx.notifications.register({ id, label })`, then `await submit({ sourceKey, target, title?, body? })` where `target` is an open target. The host bounds and flattens the text. |
| `browser` | Embedded website (macOS desktop only) | `ctx.browser.available` (boolean) and `ctx.react.createElement(ctx.browser.View, { url, storage?, label? })` inside a panel component. HTTP(S) only. |
| `decisions` | Typed judgments about text | `await ctx.decisions.decide({ state, questions, timeoutMs?, community? })`. `questions` maps 1 to 32 answer names to `{ type: "yes_no", instructions }`, `{ type: "choice", instructions, options }` (value -> when to pick it) or `{ type: "score", instructions, levels }` (lowest first). `timeoutMs` is in milliseconds (1000-30000). `community` is the relay URL the text came from; Builderlab fails without it (in an agent tool: `ctx.agents.snapshot().running.find((a) => a.key === client.key)?.relay`; in a channel panel: `channelContext.relayUrl`). Resolves `{ outcome: "answered", model, answers }` (for example `answers.urgent.probability`) or `{ outcome: "failed", reason }`; never rejects. By default Builderlab or TypeSafe answers, with Jev. |
| `host` | Commands, HTTPS, processes, files | Requires `manifest.host` grants; see below. |
| `pluginInstaller` (optional) | Ask the owner to install another plugin or check installation status | `requestInstall(...)` resolves `"installed" \| "updated" \| "cancelled" \| "unavailable"` and never installs silently. Status methods are described below. |

The installation-status methods may be missing on older hosts even when `pluginInstaller` is available, so feature-check each method before calling it. `getInstallationStatus` returns `"installed"` when the manifest ID is in the ready catalog, `"absent"` when it is not, and `"unavailable"` while the catalog is not ready. Installed status is independent of whether the plugin is enabled, contributes UI, or came from a particular install source. A subscription reports later status changes; subscribe first, then read the current status to avoid missing a change between the read and subscription. Own the subscription with `ctx.effect`:

```js
const installer = ctx.reflect.get("pluginInstaller");
if (typeof installer?.getInstallationStatus === "function") {
  const status = installer.getInstallationStatus("example.hello");
  // Use "installed", "absent" or "unavailable"; a missing method is not "absent".
}

ctx.effect(() => {
  const installer = ctx.reflect.get("pluginInstaller");
  if (typeof installer?.subscribeInstallationStatus !== "function") return;
  const unsubscribe = installer.subscribeInstallationStatus(
    "example.hello",
    (status) => {
      // Respond to a status change.
    },
  );
  if (typeof installer.getInstallationStatus === "function") {
    const current = installer.getInstallationStatus("example.hello");
    // Read the current status after subscribing.
  }
  return unsubscribe;
});
```

The table above covers the services most plugins use. The full contract for every service, with TypeScript types and examples, is in [Plugin architecture](https://github.com/block/buzz-app/blob/main/docs/plugin-architecture.md); the types are exported from [`src/plugins/author.ts`](https://github.com/block/buzz-app/blob/main/src/plugins/author.ts). Read it before you use a service that is not in this table. It describes the latest Buzz, which can have services this app does not. If a service in `inject` is missing, `apply` never runs, so check `plugin_status` after you install.

## Host access (`manifest.host`)

Everything beyond the services above must be declared in `manifest.json`; the owner reviews it at install. Undeclared commands, origins, processes and file access are refused by the host. Limits: at most 16 each of `commands`, `processes`, `networkOrigins`, `agentHooks`. Program names are bare names (`[A-Za-z0-9._-]`, at most 80 bytes, no paths), at most 16 args of 1024 bytes each.

```json
{
  "id": "example.status",
  "name": "Status",
  "apiVersion": 1,
  "host": {
    "commands": [{ "id": "status", "program": "git", "args": ["status", "--short"], "maxOutputBytes": 65536 }],
    "networkOrigins": ["https://api.example.com"],
    "processes": [{ "id": "agent", "program": "example-agent" }],
    "files": true
  }
}
```

Add `"host"` to `inject`, then:

- `await ctx.host.runCommand("status", input?)` runs a declared command (no shell, 5 s deadline, stdin only if `maxInputBytes` is declared). It returns stdout (4096 bytes by default, up to `maxOutputBytes`, at most 1048576), or `null` on failure or when output exceeds the bound. A command may declare `artifact: { path, sha256, siblings?: [{ name, sha256 }] }` (an absolute or `~/…` path, lowercase SHA-256 hex, and files beside it that must match too) to run only those verified bytes, never a program on PATH; `program` is then just its label and the declared `args` are passed to it. Interpreters and programs it calls by name are still found on PATH, so give it an absolute shebang such as `#!/bin/sh` and call programs by absolute path.
- `await ctx.host.request({ url, method?, headers?, body?, timeoutMs? })` returns `{ status, headers, body }` and throws on an undeclared origin or timeout. `url` must use an exact declared HTTPS origin (origin only in the manifest: scheme + host, no path or trailing slash). No redirects, no cookies. Plain `fetch` to other origins is blocked by the app's content security policy, so use this.
- `ctx.host.spawn?.(id, { args?, cwd?, env?, onStdout?, onStderr? })` starts a declared `processes` entry (desktop only; check it exists). Returns `{ write, end, kill, exited }`. Your `args` follow the declared ones.
- `files: true` enables `ctx.host.readFile(path, { cwd? })` (bytes, at most 50 MB) and `ctx.host.resolveDirectory(path)`. Other grants: `mcp: true` (`host.serveMcp`), `managedFiles: true`, `agentHooks: ["plugin/kind", ...]` (agent type keys such as `buzz.claude-code/claude-code`).

## UI

- Prefer host classes and tokens over custom chrome: `className="ui-card"` for a card surface, `var(--space-panel-inset)` and `var(--space-2)` for spacing, `shell-sidebar-default` for a page-sidebar root. Plain `h1`, `h2`, `h3`, `p` and `button` get host default styling. Use inline styles for layout; separate CSS is not supported.
- The host already supplies the shell, navigation, active state, error boundaries and (for panels and Settings) the outer surface, header or content column. Do not add your own page frame, header-level navigation, overlays, global stylesheet, theme or reset. Page content owns its interior padding and scrolling. Panels sit inside a host card: render only the body.
- Avoid fixed widths; the page may be narrow. Use `width: "100%"`, flex and wrapping. Colors: use host tokens (`var(--...)`) rather than hard-coded values so light and dark themes both work.

## Common mistakes

- Adding `import ... from "react"` or any runtime import, or compiling JSX with the automatic runtime (`react/jsx-runtime`). Use `ctx.react` and classic `React.createElement`.
- Forgetting a service in `inject` (`ctx.pages` is undefined and activation fails) or listing optional services (`sidebarSections`, `pluginInstaller`) there instead of using `ctx.reflect.get`.
- Doing work at module top level (it must be pure) or using `ctx.react` outside `apply`.
- Starting timers, listeners or subscriptions without `ctx.effect` cleanup, so they leak across reloads.
- A bundler emitting several chunks, CSS, or asset files. Only one `plugin.js` is loaded.
- Editing `manifest.host` and expecting `plugin_reload` to apply it; it refuses until the owner approves the update in Settings.
- Invalid ids (uppercase, underscores in the plugin id, a page id starting with `-`), or an unknown manifest key, which rejects the whole folder.
- Expecting React state to survive a reload, or a plugin added by drag and drop to be reloadable.
