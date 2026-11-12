# Contribution workflow

The repository pins just 1.58.0, Node.js 24.18.0, pnpm 11.8.0, Lefthook 2.2.2,
and rustup with [Hermit](https://cashapp.github.io/hermit/). `rust-toolchain.toml`
pins Rust 1.98.1 (including Cargo, rustfmt, and Clippy), which rustup installs
under the machine-shared `~/.rustup`.
No global tool installation is required: `bin/hermit` bootstraps Hermit and tools
are downloaded on first use. Desktop development still requires the
[Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).

From the repository root:

```sh
source bin/activate-hermit # bash/zsh; fish: source bin/activate-hermit.fish
rustup toolchain install
just --list
```

Run `rustup toolchain install` after cloning and after `rust-toolchain.toml`
changes, before an editor or parallel commands start the Rust proxies. rustup
does not serialize installs, so concurrent first use can leave the toolchain
missing a component's binaries while rustup reports it installed (for example,
`cargo clippy` fails although `rustup component add clippy` says it is up to
date). To repair it, reinstall the toolchain:
`rustup toolchain uninstall 1.98.1 && rustup toolchain install`.

Without activation, use `bin/just`, `bin/pnpm`, or `bin/cargo` from the root;
these proxies supply the pinned environment to child commands too. For example,
`bin/just web` needs no shell setup. With activation, commands also work from
subdirectories, relative to this project's justfile.

`bin/hermit` bootstraps from Hermit's public GitHub release. `bin/hermit.hcl`
selects the [public package catalog](https://github.com/cashapp/hermit-packages)
and does not override npm/pnpm registry or CA settings. Without local overrides,
dependencies use the [public npm registry](https://registry.npmjs.org/).
Existing user configuration such as `~/.npmrc` remains effective; keep any
organization-specific mirror, credentials and trusted CA paths there, not in Git.
No company package infrastructure, registry credentials or custom CA bundle is
required by this repository. Do not disable TLS verification or package integrity
checks. If your network intercepts TLS, configure its trusted CA locally rather
than committing machine-specific paths or disabling certificate verification.
No user-level npm configuration edit, Corepack bootstrap, or temporary
tool PATH is needed for a clean public-registry setup. Commit the `bin/` scripts
and package symlinks; `.hermit/` contains ignored local state.

CMake is pinned through Hermit for the native Opus codec build.

All tool versions are unchanged by the public-tooling migration. The public
catalog does not yet include Node 24.18.0, so `bin/packages/node.hcl` pins its
[official downloads and checksums](https://nodejs.org/dist/v24.18.0/SHASUMS256.txt)
as a repository-local override. Remove that override when the public catalog
supports the same pin; do not silently downgrade it.

The pinned pnpm Hermit package supports Apple Silicon macOS but marks Intel macOS
(`darwin-amd64`) unsupported. Do not silently substitute a different pnpm version
on an unsupported platform; resolve that tooling gap first. Other platforms still
need their own validation.

- `just web [args...]`: install locked dependencies and forward arguments to Vite,
  e.g. `just web --port 1431 --host 127.0.0.1`. Vite uses the requested port
  (default: derived from the worktree path) or the next available port, allowing
  parallel browser development.
  Use `just web profile` for opt-in Chromium and broker CPU profiles. Profiling
  binds only `127.0.0.1`; wildcard, hostname, and IPv6 `--host` values are rejected
  so the captured page and development broker have one unambiguous owner. Use
  `just web profile --network` to additionally record sanitized browser network
  metadata in `network.json`; payloads, cookies, authorization headers, query strings,
  fragments, and WebSocket frame data are omitted. Use `just web profile --trace`
  to record a Chromium DevTools Performance trace (`chromium-trace.json`, with
  style/layout/paint events, React's performance tracks, and denser CPU samples)
  in place of `chromium-renderer.cpuprofile`; traces are large, so keep traced
  sessions short. Press Ctrl+C to finalize the capture; the command prints the
  `.profiles/...-web` output directory. Load `.cpuprofile` and trace files in
  Chromium DevTools (**Performance** > **Load profile**).
  Use `just web profile --scenario <file>` for an unattended capture. The file
  is any JavaScript module, inside or outside the repository (a relative path
  resolves from the repository root), that default-exports
  `async (page, { signal }) => {}` and drives the Playwright `page`. When it
  returns, the command saves the app's [client metrics](client-metrics.md)
  export as `client-metrics.json` and exits without Ctrl+C. A scenario that
  throws or does not finish within five minutes fails the run: the command
  prints the scenario's stack and the directory holding the remaining
  artifacts, saves no client metrics, and exits nonzero. Ctrl+C during a
  scenario also saves no client metrics but exits zero, like any interrupted
  capture. `signal` aborts on Ctrl+C, at the timeout, and when the capture ends,
  so pass it to any wait that would otherwise outlive the run. A scenario
  outside the repository resolves bare imports from its own location, not from
  the repository's `node_modules`. A scenario runs as your real account, so
  keep it read-only. Every capture starts from a fresh browser profile with no
  community selected unless `BUZZ_DEV_OPEN_RELAY=1` is set. `manifest.json`
  records the scenario file and `relay`, the `https://` origin of the
  `BUZZ_RELAY_URL` that Vite resolves from the environment or its `.env` files;
  a value the dev server would reject is recorded as `null`. To profile in
  another Vite mode, pass it as `--mode <mode>` so the manifest follows it.
- `just desktop [args...]`: install locked dependencies and forward arguments to
  Tauri, e.g. `just desktop --port 1431 --no-watch`. The desktop adapter consumes
  `--port N` or `--port=N` to set both Vite's port and Tauri's development URL;
  Tauri's own `--port` is for its static-file server, not Vite. Without this flag,
  the adapter derives a stable port from the worktree path (the same derivation
  `just web` uses) and prints the chosen URL. Different paths can still collide.
  Ordinary desktop development runs do not claim the OS `buzz` URL scheme or the
  packaged single-instance lock, so multiple worktrees can run at once. Packaged
  and debug bundles still use `buzz`. See [OS deep links](deep-links.md).
  Desktop requires the exact port to be free; an occupied port fails rather than
  opening another copy's server. Other arguments, including runner/application arguments after `--`, pass
  through unchanged. Port configuration is prepended so Tauri parses it even with
  implicit runner arguments. Explicit `--config` arguments merge afterward and can
  override it; keep their development URL and frontend command consistent. Use `--`
  before runner/application arguments if they contain their own `--port` flag.
  `just desktop me` signs in with your installed Buzz's key, read-only, instead
  of the debug build's own. On macOS it also sets up, on first use, a Keychain
  helper and a local signing certificate: click **Always Allow** on each Keychain
  dialog that first launch, and later launches, rebuilds and new worktrees show
  none. Agents and tests use plain `just desktop`. See
  [the local credential helper](identity.md#local-credential-helper-on-macos).
  On macOS, `just desktop profile` uses Instruments' Time Profiler to launch and
  record only the Buzz native parent process, not every process on the desktop.
  WebKit subprocesses and the Vite broker are outside this native trace; use web
  profiling when renderer/broker CPU coverage is required. Native file watching is
  disabled during capture. Press Ctrl+C to finalize and validate the trace; the
  path, which opens in Instruments. Use `just profile-clean` to remove all generated
  web and desktop captures.
- `just desktop-bundle [args...]`: bundle a debug desktop app for testing OS deep
  links and notifications on macOS, where those APIs require a bundled application.
  Pass `--launch` to build and open the `.app` in one command; quit every other Buzz
  copy first. `--launch` is macOS-only and requires the default app name and target
  path, so it rejects bundle, target, runner, config, and Cargo/Tauri artifact-path
  overrides rather than risk opening a stale build. Without it, the recipe defaults
  to a `.app` bundle unless `--bundles` or `--no-bundle` says otherwise, and passes
  everything else to `tauri build`.
  The bundle uses `buzz`, as does release bundling with `pnpm tauri build`.
- On macOS, set `BUZZ_DEV_SIGNING_IDENTITY` in `.env.local` to an installed code
  signing certificate name or SHA-1 hash (`security find-identity -v -p codesigning`
  lists them). A stable certificate-backed identity is required to test macOS
  notifications across rebuilds; Tauri's default ad-hoc signature changes with the
  binary and can be rejected with `UNErrorDomain error 1`. `just desktop-bundle`
  passes the identity to Tauri's macOS signer; the process
  environment takes precedence, including an empty value to disable this setting.
  Keep the same certificate and development app identifier across rebuilds. After
  the first signed build, enter your login Keychain password and choose **Always
  Allow** when Buzz requests its saved identity; later builds should retain that
  approval. Ad-hoc signatures change with the binary and cannot retain that trust.
  An unavailable certificate fails the build rather than silently signing ad-hoc.
  This setting leaves `just desktop` and release builds unchanged. Explicit Tauri
  `--config` arguments still merge after the local defaults.
- For opt-in agent automation of the macOS native webview, see
  [Native webview automation](native-mcp.md).
- `just design [args...]`: install locked dependencies, start the standalone
  design-system viewer, and open it in your browser. Arguments pass through to
  Vite, e.g. `just design --port 1444`. The default port is 1442; an occupied port
  fails rather than switching automatically. This starts neither Tauri nor the
  live relay broker. Press Ctrl+C to stop it.
- To pause notifications in your local dev server, set `BUZZ_DEV_NOTIFICATIONS=0`
  in `.env.local` and restart the server. Only `0` pauses alerts and permission
  requests; removing the setting restores normal behavior. Saved preferences are
  untouched and production builds ignore the variable.
- To open the default relay's community on a fresh dev port, set
  `BUZZ_DEV_OPEN_RELAY=1` alongside `BUZZ_RELAY_URL` in `.env.local` and restart
  the server. Only `1` enables it; a viewer's existing saved choice on that port,
  including Personal space, wins. Production builds ignore the variable. The OG
  `BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY` name is a **presence-only dev alias**:
  even empty, `0` or `false` enables it when `BUZZ_DEV_OPEN_RELAY` is absent.
  Explicit `BUZZ_DEV_OPEN_RELAY=0` opts out. Neither input provides packaged relay
  connectivity. See [configuration parity](configuration.md).
- `just fullstack`: reserved, exits unsuccessfully with an explanation. It will
  eventually start local Docker services including the Buzz relay backend.
- `just iterate`: install locked dependencies, format Rust, apply Biome safe
  fixes, check TypeScript, and build the frontend. Remaining problems fail the command. No tests or
  native compilation run here.
- `just scan`: install locked dependencies, check formatting/lint/types, build
  the frontend, run Node/Vitest/plugin-manager tests, headless Chromium/WebKit
  journeys, Rust Clippy, and native Rust tests. It does not auto-fix source.
  This is broader validation, not a signed package or a cross-platform test.

Before the first `scan`, install the pinned browser engines with
`bin/pnpm test:browser:install`; missing engines fail rather than skip. Linux native
notification tests also require `dbus-daemon` (installed in CI). They start and stop
isolated test buses, never use the desktop session bus or display real banners. See
[browser regression coverage and measurement limits](browser-testing.md).

Installs run on every invocation to account for branch and lockfile changes.
pnpm reuses its shared package cache; no node_modules directory needs to be copied
into a new worktree. Native dependencies are fetched by Cargo as needed into the
shared `~/.cargo`. Each worktree compiles into its own `target/`, overriding any
user-level `target-dir`, so its app and bundled resources always match its sources;
remove stale worktrees (or run `bin/cargo clean` in them) to reclaim that space.
The bundled `buzz` CLI is the exception: it builds from a pinned block/buzz
revision, not worktree sources, so linked worktrees share one build in the main
checkout's `target/`.
Native compilation still takes time in each new worktree. Parallel worktrees normally need
no port flags: each derives a stable default from its path. Pass `--port` if paths
collide, the default is occupied, or you run a second instance from one checkout;
ports must be integers from 1 to 65535. Browser dev
prints its selected URL and can use a later port when the requested port is
occupied. Port selection does not isolate credentials or native plugin data;
use the existing `BUZZODZ_PROFILE` setting for separate plugin profiles.
A public `BUZZ_DEV_VIEWER` pin enables the legacy development broker for either
command. Without it, browser development has no live broker identity, while
supported desktop development can use native identity and relay access. See
[host modes below](#shared-logic-and-host-boundaries) and
[the broker setup requirements](#live-relay-development).

After creating a worktree, bootstrap it from the checkout whose local development
configuration it should inherit:

```sh
scripts/bootstrap-worktree.sh /absolute/path/to/source/checkout
```

The idempotent script copies the source checkout's git-ignored `.env.local`
without overwriting an existing target, then uses the new worktree's Hermit
proxies to run `bin/rustup toolchain install` and
`bin/pnpm install --frozen-lockfile`. It rejects checkouts from another
repository. Keychain credentials and pnpm's package cache remain machine-shared;
do not copy private keys, `node_modules`, build output, `.npmrc`, or other ignored
files. Git hooks need no per-worktree step; see [Git hooks](#git-hooks).

### Worktree Dock labels (macOS)

`just desktop` adds the current branch suffix to the Dock icon in linked Git
worktrees (for example, `person/my-feature` shows `my-feature`). Detached
worktrees use the checkout directory name. Restart the desktop command after
switching or renaming a branch; no Cargo clean is needed.

The launcher reuses the existing badge design and generates an icon under the
ignored `src-tauri/target/dev-icons/` directory. The generated bytes determine its
filename, so changed labels, source artwork, or rendering update Tauri's embedded
icon even with a warm build. Generation requires macOS Swift/AppKit and `iconutil`;
if it fails, startup warns and continues with the ordinary icon. Explicit Tauri
`--config` arguments still take precedence over the generated icon and port.

Ordinary checkouts, non-macOS launches, and `pnpm tauri build` keep their existing
icons. This does not change the app identifier, credentials, profiles, or
notification settings.

## Source layout

Shared React frontend for web and Tauri desktop, with bundled page plugins and
local desktop plugins managed by `buzzodz`. Channels reads the relay through a
shared data service; the GitHub plugin adds rich reference panels to channels.

- `src/`: shared browser-compatible application UI and feature logic.
- [`browser-host/`](../browser-host/README.md): Node host for browser development
  and tests; not a production browser backend or code shipped in desktop.
- `src-tauri/`: native Rust host used by desktop development and releases.
- `scripts/`: development/build tooling, including Vite developer settings and
  the live setup diagnostic probe.

See [shared logic and host boundaries](#shared-logic-and-host-boundaries)
for ownership and runtime modes. Host-specific custody and I/O stay in the host;
platform-neutral feature policy belongs in its existing `src/features/*` owner.

### Code entry points

- `src/main.tsx` → `src/app/App.tsx`: startup and app shell
- `src/plugins/api.ts` and `src/features/{pages,panels}/service.ts`: plugin contracts
- `src/plugins/runtime.ts`: Cordis activation and disposal
- `src/plugins/storage.ts`: web/desktop storage adapter
- `crates/plugin-manager`: shared Rust manager and `buzzodz`
- `src-tauri/src/lib.rs`: desktop commands delegating to that manager

The app composes core services once in `src/app/services.ts` and passes the page
reader directly to the React shell. Cordis owns plugin dependencies and effects;
React owns rendering, subscriptions, and page selection. The shell is ordinary
app UI and remains available when no plugins are active.

`src/features/pages` owns page registration, activation filtering, and rendering.
It observes plugin status through a Cordis service; it does not import app wiring.
`src/plugins` owns installation and executable lifetimes, including the adapter
from Cordis state changes to observable plugin status. Bundled features use the
same registration contract as external plugins. Target-based panels provide a second extension point alongside pages; both use the same
contribution ownership and readiness implementation.

Desktop release builds are described in [Desktop test releases](releases.md).
To exercise a local macOS bundle with embedded frontend assets:
`pnpm tauri build --debug --bundles app`. Agents and its read of the installed
Buzz library are described in [Agents](agents.md#community-inventory).

## Running the app

Hermit pins just, Node.js 24, pnpm 11.8.0, and rustup in `bin/`; no global tool
installation is needed. From the repository root, activate the pinned environment:

```sh
source bin/activate-hermit
just web
just desktop
```

Or run `bin/just web` / `bin/just desktop` without activation. Tools download from
public Hermit sources. Dependencies use npm's public registry by default; local
registry and CA settings remain in effect. Desktop
builds still require the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
The exact pins, registry settings and the pinned pnpm package's Intel Mac
limitation are described [above](#contribution-workflow).

Both commands forward arguments to their development tool (Vite or Tauri).
Both rebuild Vite's dependency cache on every start (`vite --force`, under a
second), so imports present at startup don't trigger a mid-load reload. Imports
added while a server runs still can. Servers in one checkout share that cache,
so starting a second one rebuilds it under the first, which may reload; restart
the first if it stays blank, or run the second from its own worktree.
The default port is derived from the worktree's path, giving each checkout a
stable default that normally avoids collisions between parallel worktrees;
`just desktop` prints the URL it chose. Override it with `just web --port 1431`
or `just desktop --port 1432`. Browser servers prefer the requested port and
use the next open port automatically; desktop requires the exact port to be free and keeps
Vite and the native window on the same URL. Use an explicit port if two paths
collide, another process occupies the default, or you start a second instance
from the same checkout:

```sh
just desktop
# A second instance from the same checkout:
just desktop --port 1431
```

Ports do not isolate account credentials or native plugin data. For separate
plugin profiles, use the existing `BUZZODZ_PROFILE` setting described in
[the `buzzodz` CLI](plugin-architecture.md#the-buzzodz-cli).
Without a public viewer pin, browser development runs the shell/fixtures;
supported desktop development can use [native identity and relay access](identity.md).
See the [host-mode matrix](#shared-logic-and-host-boundaries).
`just iterate` applies formatting and runs fast checks plus the frontend build.
`just scan` adds tests and native checks. [PR CI](../.github/workflows/ci.yml) runs
those checks in cached, parallel jobs with sharded browser journeys.
Staged-file pre-commit and related-test pre-push hooks run through lhm where it
is installed; otherwise run `just hooks` (or `bin/just hooks` without activation)
once per clone. See
[hook behavior and partial staging](#git-hooks).

### Design system

Run `just design` (or `bin/just design` without activation) to install locked
dependencies, start the standalone design-system viewer, and open it in your
browser. It uses port 1442 and does not start the desktop app or live relay broker.
If that port is occupied, choose another with `just design --port 1444`.
Press Ctrl+C to stop the server.

### OS deep links

Desktop builds register `buzz://` with the OS, the scheme in-app links already use, so
opening a `buzz://message?channel=…&id=…`, `buzz://channel/<id>`, or
`buzz://channel/<id>/<event>`, or a repository/PR/issue link outside the
app focuses it and opens that destination, on a cold start too. A
`buzz://join?relay=…&code=…` invite opens **Join a community** prefilled; it
joins nothing until the user continues. Entity Git browsing
uses the development broker or, in desktop builds, native reads through the system `git`.
Bundled and released builds use `buzz://`; each packaged launch claims its OS handler. Ordinary
`just desktop` runs leave any installed handler alone. macOS only routes a scheme
to a bundled app, so test there with `just desktop-bundle`; Windows and Linux
bundles register themselves at launch. See [OS deep links](deep-links.md) for
per-platform steps and limits.

## Live relay development

For manual testing of shipped behavior, use `BUZZ_DEV_VIEWER= just desktop` to
exercise the native path, even if `.env.local` contains a public viewer pin.
Broker-backed runs do not prove native acceptance. Browser capabilities remain
supported; consolidate shared policy rather than maintain parallel feature logic.
See [host boundaries and testing guidance](#shared-logic-and-host-boundaries).

Live **browser/broker development** requires an existing Buzz account in the OS credential
store: the `buzz-desktop` / `secrets` Keychain entry on macOS, or the same entry in
the freedesktop secret service on Linux (read with libsecret's `secret-tool`, so
install `libsecret-tools` and run inside an unlocked desktop session). This development broker is not native
sign-in and is not included in packaged builds. `just web` and `just desktop` run
it automatically once `BUZZ_DEV_VIEWER` is configured, including inside the native
window. Without that pin, web stays in shell/fixture mode and supported desktop
uses its separate [native identity path](identity.md). Removing the pin can
change the active identity; it does not migrate the legacy key.

1. Copy your existing Buzz account's **public key** (npub or 64-character hex).
2. Add it to the git-ignored `.env.local` at this repository's root. The optional
   relay settings below are examples only; replace them with your community's origin:
   ```dotenv
   BUZZ_DEV_VIEWER=npub1YOUR_PUBLIC_KEY
   # Optional default for unscoped development-broker requests:
   BUZZ_RELAY_URL=wss://relay.example.com
   # Optional: on a fresh dev port, save and select BUZZ_RELAY_URL as a community.
   BUZZ_DEV_OPEN_RELAY=1
   # Optional compatibility map for memberships saved with short aliases:
   BUZZ_COMMUNITY_ALIASES='{"example":"wss://relay.example.com"}'
   ```
   Never put an nsec/private key in this file. The public pin explicitly authorizes
   the account to use; it does not import or change a key. Relay URLs and aliases
   are public configuration, not secrets. With both relay settings unset, there is
   no default relay or alias map; Personal space and communities saved by canonical
   URL remain usable. Configuration does not automatically join a community:
   `BUZZ_DEV_OPEN_RELAY=1` only saves and selects the default relay locally on a
   dev port whose saved choice is absent. It does not implicitly join a community,
   accept an invite, or publish a profile. Normal session traffic and presence still
   apply.
3. Start a development target:
   ```sh
   just web
   # Or, instead of web:
   just desktop
   ```

   Open the Local URL printed by `just web`. Each worktree derives a stable
   default port from its path, but two paths can still collide. If the default
   is busy, use `just desktop --port 1431` (or another free port) instead of
   stopping the other copy.

The broker reads the existing Keychain credential only after validating the
public pin, refuses mismatches and never falls back to another credential. If it
reports a mismatch, check which account your existing Buzz installation uses;
do not delete or replace its Keychain entry. Environment variables override
`.env.local`. Restart the dev server after changing the configuration. Without
an existing supported credential, live development is unavailable; shell and
fixture tests still work.

Media attachments in live development need `ffmpeg` on the server’s PATH for
video, HEIC/HEIF, and the existing `voice-note-*.wav` exception. Install ffmpeg on the host (macOS: `brew install ffmpeg`; Linux: your
distribution’s ffmpeg package); HEIC tile grids require ffmpeg 8 or newer.
Like `block/buzz`, real conversion tests return early when optional host tools
are missing; tiled-HEIC tests also require ffmpeg 8+ and ffprobe. These tools are
not pinned through Hermit or provisioned by CI. Packaged apps use the host's
installed ffmpeg and reject HEIC preparation if its version is older than 8 or
cannot be determined. The broker
prepares canonical H.264/AAC MP4 or single-frame JPEG before upload hashes/signs
those exact bytes. Missing tools and unsupported codecs fail visibly. No generic
audio conversion or recording UI is added.

JPEG/PNG/WebP cleanup preserves orientation and alpha; GIF/APNG/WebP structural
cleanup preserves animation. Animated images requiring ICC or EXIF orientation
transforms reject rather than silently change appearance. Snapshot PNG manifests
survive cleanup. A lazy, cancellable lossless WebP encoder covers still-image pixel
cleanup on WebKit, which lacks a canvas WebP encoder.

Final-file defaults match old Buzz: 50 MiB images, 10 MiB GIFs, 100 MiB generic
files, 500 MiB videos. The relay remains authoritative and can enforce lower
limits, 25-million-pixel images, and video codec/duration/resolution constraints.
The client separately bounds source files at 500 MiB (voice notes: 128 MiB), ten
files per draft, and 1,000 MiB retained sources per session. These source/batch
safety budgets are not old-relay final-byte limits. Preparation can grow or shrink
files. Browser Blobs still retain complete prepared payloads; only the broker's
transfer buffers are streaming. Private spool files and conversion children are
request-owned, cancelled on disconnect and cleaned before admission is released.

Picker/paste/drop share the same tab-local draft. In the main window, Send hands
unfinished uploads to a background send that keeps uploading across navigation and
returns the draft and files to their conversation if it fails or is cancelled;
other composers wait for uploads before sending. Navigation pauses a draft's
unfinished uploads until its composer returns. Reload loses unsent files. Live
uploads use the development broker in dev runs and the native `relay_upload` path
in packaged desktop builds. The native host prepares HEIC and supported
video/voice-note inputs with fixed demuxers and bounded child processes before
upload; it requires ffmpeg installed on the host.

The broker supports reads, live traffic and basic message sending **as your real
account**. Profile changes and invite admission can also write to real communities.
Open the community picker, choose **Join a community**, and type the community's `wss://` or
`https://` relay origin (no path, credentials, query or fragment). For example,
`wss://relay.example.com` and `https://relay.example.com` identify the same relay
origin. Continue contacts that destination using your
identity; you review the community before you join or publish a profile. Then open
Messages, choose a channel, and click a GitHub reference. See
[the channel extension contract and data budgets](channels.md) for ownership,
performance, validation, and limitations.

Messages opens by default. Channels is required and cannot be disabled; optional plugins such as GitHub can be toggled in Settings.

See [client and community ownership](communities.md) for the minimal join/profile flow, session scopes, and switching checks.

## Shared logic and host boundaries

Browser and desktop share the React application, community sessions, durable
outbox, protocol models and live scheduler. **The goal is one code path per feature
in development and release:** desktop development uses the same shared frontend
and Rust host as packaged desktop, not a Node implementation of the feature.
`browser-host/` supplies browser-development host support and broker tests, not a second
owner of feature logic. **Preserve supported browser capabilities:** reduce
duplicate implementations, not available workflows. Reuse shared feature owners
rather than add parallel Node feature logic; native-only capabilities do not
require speculative browser parity. Develop and test those with
`BUZZ_DEV_VIEWER= just desktop`. Node code does not run in a browser merely because
it serves one, and packaged desktop has no Node backend.

| Mode | Identity and relay host |
| --- | --- |
| `just web`, public `BUZZ_DEV_VIEWER` pin | Node broker using the pinned existing legacy identity (macOS/Linux) |
| `just web`, no pin | Shell/fixtures; no live broker identity |
| `just desktop`, public pin | Legacy broker identity/relay access inside the native window; native identity is disabled (not an acceptance mode) |
| `just desktop`, no pin | Native identity/relay access on supported macOS, Windows and Linux |
| Packaged desktop | Native host; production builds exclude the dev broker regardless of the pin |

A static frontend build does not supply a standalone browser login/backend.
The public pin does not migrate keys. Native debug worktrees share a credential
namespace distinct from release and legacy broker credentials; ports and plugin
profiles do not isolate those keys. Removing the pin may change the active
identity, not just the transport. Do not change defaults, credentials or a running
app as incidental cleanup. See [identity custody and acceptance](identity.md).

### Where behavior belongs

- Put platform-neutral models, edits and protocol policy in their existing
  `src/features/*` owner, with current callers rather than speculative adapter
  parity. The Node host and native frontend adapter can reuse dependency-free
  TypeScript where appropriate;
  [sidebar edits](../src/features/relay/sidebar-edits.ts) and
  [community commands](../src/features/communities/admin-protocol.ts) are examples.
  Shared modules must not depend on Node, Tauri or a dev-host implementation.
- Keep signing keys, decryption, secure storage, subprocesses and host I/O in the
  host. Shipped Rust IPC boundaries retain their own validation, signing policy,
  destination/identity binding, resource limits, cancellation and lifecycle
  ownership. Moving checks into shared frontend code is not a substitute for Rust
  enforcement. The relay remains the access-control authority. Existing broker
  endpoints keep their safety checks while they remain callable; this does not
  require a Node endpoint or signing-policy copy for a new feature.
- **Frontend TypeScript checks + Rust enforcement:** both ship. Shared concrete
  contract cases are the long-term pattern for necessary cross-language logic,
  not a universal adapter or code generator. Existing JSON fixtures can be read by
  Vitest and Rust `include_str!`.
- **Node browser host + Rust native host:** only Rust ships in packaged desktop,
  but browser workflows still need host support. Share application policy where
  practical; retain necessary host enforcement and I/O. Shared cases check drift
  wherever both hosts implement the same contract, without requiring automatic
  parity. Document intentional or unresolved differences with separate expected
  outcomes; neither implementation automatically defines intended policy.
  Changing outcomes is a behavior decision, not a refactor. Do not add a second
  source of feature policy in `browser-host/`.

### Review and evidence

A cross-host change names its feature owner/current consumers, supported modes,
behavior preserved or explicitly approved differences, and the duplicate code it
removes. Update the feature's contract cases and relevant wiring tests in the
same change. Reuse existing runners and CI; this is not an extra full-suite gate
for each edit. Keep feature details with their owner, not copied into this guide.

[Canvas shape cases](../src/features/channel-templates/canvas-signing-contract.json)
check the existing Node/Rust contract for kind-40100 tag shape, including an
explicitly rejected native deserialization case; each host separately tests the
UTF-8 content limit. This is not whole endpoint parity: broker freshness checks,
native serialized-event limits, HTTP/IPC authorization and publication outcomes
are separate layers. Keep host-specific checks and regression coverage while the
corresponding boundary is callable, including after any adapter replacement.

**Manual testing of anything that ships uses `BUZZ_DEV_VIEWER= just desktop`.**
The explicit empty value overrides a pin inherited from `.env.local`; merely
unsetting the shell variable does not. This selects the shipped native code path,
not the release credential namespace or a release bundle. Packaging, OS integration
and release-specific behavior still need the appropriate packaged-build checks.
Broker-backed runs, including pinned native windows, do not count as acceptance.
They remain useful for browser diagnostics and existing broker tests, but do not
prove native signing, OS storage, networking or filesystem behavior.

Report the exact snapshot and host/mode exercised. Native/live acceptance needs an
agreed isolated identity/data setup; browser fixtures and test identities must
never use real keys. Do not launch a native app or switch someone's active identity
merely to follow this testing guidance.

### Broker consolidation and completion

The behavior-preserving cleanup pass shares status text/emoji limits, DM
participant-set policy, and sidebar intent rules with their existing
`src/features/relay` owners. The broker still executes those checks host-side and
retains its stricter untrusted-envelope checks; native Rust enforcement is
unchanged. Status reads still validate raw text before trimming, while local edits
trim first. Star and mute commands share one broker implementation in
`sidebar-toggle.mjs`; their distinct absent-unstar/unmute behavior stays in the
shared edit owner. This does not make broker and native signing policies identical.

There is no follow-up retirement queue. Further consolidation needs a demonstrated
duplicate responsibility, a current shared owner or justified replacement, and
preserved browser and native behavior. Necessary host-specific enforcement and
I/O are not duplication to remove merely because two hosts implement them.

A broker endpoint/module can be removed only after a replacement preserves its
supported browser workflow and custody guarantees, all callers move, and relevant
regression coverage follows. Native acceptance alone does not prove a browser
replacement works. Capability retirement is a separate explicit product decision,
not part of this cleanup; do not weaken a callable endpoint to reduce line count.

Developer tools live in `scripts/` (`developer-settings.ts`,
`live-setup-probe.mjs`), separate from `browser-host/`; they are not Rust feature
mirrors. Legacy library and hosted-community helpers (`agent-library.mjs`,
`builderlab.mjs`) are not automatically replaced by native identity. A transport
replacement or new backend needs a separate design decision. This cleanup changes
no runtime defaults or credentials.

## Interactive product iteration

While shaping the first version, default to **edit → human tries the running app
→ adjust**. A manual feedback handoff is not a review or shipping gate.

- Reuse the agreed development worktree and branch, with one owner of product
  edits. Keep one dev server running: `BUZZ_DEV_VIEWER= just desktop` for manual
  testing of shipped behavior. `just web` remains useful for browser-only
  diagnostics and fixtures, not acceptance. Vite handles supported frontend
  updates without a package rebuild. State when a reload/restart is needed;
  coordinate native launches with the human rather than restarting their app.
- Make small, coherent changes and hand them back as **ready to try**, naming
  what to exercise and which checks ran or remain deferred. Do not wait for E2E,
  native compilation, independent review, or a full build before each ordinary
  UI feedback round. Keep a short list of changed behaviors and deferred checks
  in task notes so the later validation pass has a bounded scope.
- Use editor/compiler feedback and cheap targeted checks where useful. Add
  focused regression tests with behavior, but do not make test-harness work a
  prerequisite for ordinary visual feedback. `just iterate` is an optional
  checkpoint, not a per-edit requirement: it installs, formats, type-checks and
  builds, rather than merely refreshing the app. Local checkpoint commits use
  the existing staged-file hook; no hook bypass is needed.
- When the human is happy with a coherent batch, finish its regression coverage,
  self-review, and obtain independent review where risk warrants. Let mandatory
  pre-commit/pre-push hooks own their checks; run focused behavior checks they do
  not cover and use existing CI for broad validation. Do not duplicate hook or
  CI suites locally by default. Run `just scan` only when explicitly requested or
  needed to reproduce a broad integration failure, not for every review,
  integration, or handoff. Attribute validation to the checked snapshot; later
  edits require appropriate revalidation. Before delivery, compare the branch's
  merge base with the fetched target branch: GitHub PR checks run the merged tree,
  which can include tests absent from the feature branch. Inspect incoming changes
  that overlap changed UI contracts (including accessible names), integrate them,
  and run the affected test files rather than assuming branch-only passes cover them.
  Shared access-gating changes also affect standalone composer/reaction fixtures,
  broker filter models, and restored-navigation/unread journeys. Repair stale
  fixtures without loosening authority, then finish those journeys: an early mock
  failure can mask a later production lifecycle regression.
  Fix failures and rerun the affected gate rather than repeating unchanged successful
  work. **Validated** means the
  required checks passed, not merely that the screen looked right; pending CI
  and untested native/browser behavior remain explicit gaps.

### Performance is acceptance, not a follow-up

For changes that add startup/sidebar work, reads or channel switching, include a
short cold/warm check in the feedback round. Correctness-only passes do not
establish that opening stayed fast. Optional names, avatars and speculative work
must yield to opening/reading a conversation; keep relay admission and access
checks intact. A failed read must expose retry rather than leave a false spinner.

Use the focused [channel-opening contract](browser-testing.md#channel-opening-performance)
when changing that path; do not add the entire browser suite to each UI edit.
Record click-to-visible time separately for cold and warm states, and split cold
waiting into reader queue, broker admission, network and verification/render work.
Compare equivalent cache/connection states. After the human is satisfied, include
these regressions in the ordinary batch gate. Do not raise a budget just to make a
regression green; explain the changed work and obtain agreement.

Exceptions: check safety-critical changes (auth/signing, persistence/migrations,
protocol semantics, or destructive writes) before exercising those paths against
real data. State the risk and required check up front. Native, dependency and
build-configuration changes still warrant broad validation; `FOUNDATION` edits
still require explicit human guidance. Defer expensive validation during ordinary
product iteration, not safety or the final quality gate. Do not turn `iterate`
into an ever-growing full test suite.

## Git hooks

### Pre-commit checks

`lefthook.yml` declares ordinary `pre-commit` and `pre-push` hooks. On a machine
with [lhm](https://github.com/block/lhm) there is nothing to install: lhm's global
hooks discover this file and merge it with the machine policy each time a hook
runs; `lhm dry-run` from the repository root prints the merged result. Without
lhm, install once per clone (linked worktrees share the installed hooks):

```sh
just hooks # or bin/just hooks without Hermit activation
```

This recipe runs the pinned `bin/lefthook install`; it never changes Git config.
If installation refuses because of a global `core.hooksPath`, **do not follow
Lefthook's suggested fixes**: `--reset-hooks-path` and
`git config --unset-all --global core.hooksPath` can disable machine hooks in
other repositories. Running `lefthook install --force` **without first setting a
clone-local path** can replace hooks in the global directory, affecting every
repository that uses it. Under lhm, install nothing.

For a **non-lhm** global path, if you explicitly want this clone to use its own
hooks instead, first remove any stale worktree-local overrides as described
below. Then set the clone-local path before running `--force`, from either
checkout:

```sh
git config --local core.hooksPath "$(git rev-parse --path-format=absolute --git-common-dir)/hooks"
bin/lefthook install --force
```

The absolute path works in the main checkout and linked worktrees; the global
setting is unchanged, but its hooks no longer run in this clone. Do not use this
override for lhm.

The installed hooks fail rather than silently skip when they cannot find
Lefthook; `bin/lefthook uninstall` removes them. Standalone shims select
`bin/lefthook`. **Under lhm, activate Hermit before committing or pushing**
(`source bin/activate-hermit`), since lhm selects `lefthook` from `PATH` and does
not read the repo's `lefthook:` setting; `min_version` rejects runners older than
2.2.2. **If no Lefthook exists on PATH, lhm 0.14.1 can silently skip hooks
instead** (especially in linked worktrees); the repository config cannot prevent
that fallback. Use Git from an activated shell, or a client that actually
inherits that shell’s environment. Do not bypass hooks or change machine policy.

Pre-commit runs these jobs in order and stops at the first failure: refuse staged
names containing `*`, `?`, `[` or `\`, which Git would expand as globs when
Lefthook restages them; the staged icon policy (known alternate icon families,
direct upstream imports outside the design-system gateway, whole-catalog
imports); pinned Biome formatting and safe lint fixes on staged JS/TS/JSON/CSS;
and rustfmt on staged Rust files. Remaining warnings/errors block the commit; no
unsafe lint fixes are applied. Deletions and unsupported formats (including
Markdown, HTML and YAML) are not formatted here. The hook does **not** run types,
tests, builds, Clippy, or a whole-tree formatter. `just iterate` remains the
optional whole-tree fix/build command; `just scan` is an opt-in broad diagnostic.
Both reject remaining Biome warnings.

Lefthook owns partial staging: it hides the unstaged hunks of partially staged
files while the jobs run, restages the formatted files, then restores the hunks,
so unstaged hunks never enter the commit. A failed restore keeps Lefthook's
`lefthook auto backup` entry in `git stash list`; preserve current edits, then
use `git stash apply --index <entry>` in a clean worktree at the original base.
When a formatter changes the same lines
as an unstaged hunk, the commit is blocked with "conflict while merging unstaged
changes" and the index, the files and unrelated edits are left as they were;
format the file first (`just iterate` or the editor), then reselect your hunks.
A failing read-only check leaves the index untouched; a failing formatter stages
nothing of its own, while an earlier formatter's restage stands. rustfmt follows
`mod` declarations into the working tree like `cargo fmt --all`; only staged
files are restaged. Do not edit or stage concurrently with a commit. This is a
developer guardrail, not a security boundary or a substitute for CI and
risk-appropriate behavior checks. Tool/config dependency changes require
relevant integration evidence, not an automatic local full scan.

### Machine policy under lhm

lhm runs the repository jobs first, then the machine's commands in the same hook:
`sadscan` after the pre-commit jobs and `check-push-org` after the push lanes. A
policy rejection still blocks the push, after the project checks have run. The
machine policy skips pre-commit during merges and rebases; CI remains the gate.

Checkouts set up by the previous Buzz installer carry a worktree-local
`core.hooksPath` that now points at deleted files, so Git either runs no hooks
there or fails every commit. In each such worktree run
`git config --worktree --unset core.hooksPath` and leave
`extensions.worktreeConfig` set.

Verify the wiring with:

```sh
git config --show-origin --get core.hooksPath # lhm's hooks directory, or unset
bin/node --test tests/integration/hooks.test.mjs
# Optional bounded probe, with isolated lhm system/user configuration:
BUZZ_REAL_LHM="$(command -v lhm)" bin/node --test --test-name-pattern='real lhm' tests/integration/hooks.test.mjs
```

For human acceptance, in a disposable checkout: commit a fully staged unformatted
source file and confirm it lands formatted; stage half of a file and confirm only
the staged hunks are committed with `git stash list` unchanged; introduce a Biome
warning and confirm the commit is blocked with the index unchanged. Automated
probes do not replace this confirmation before PR readiness.

### Fast pre-push feedback

Pre-push runs the project TypeScript check (`tsc --noEmit`), then Vitest tests
related to the branch's changed JS/TS inputs, using the locally available merge
base with `origin/main`. Documentation-only, native-only and Rust-only pushes
skip this runner. Shared JS configuration/dependency
changes, source deletions, or a missing base run the full Vitest suite instead.
The selector explicitly includes theme tests for their directly read CSS/bootstrap
inputs, the Vite config test for `vite.config.ts` (unit tests use
`vitest.config.ts`, so it selects only its importers), and the app composition
test for source edits that its Vite loader hides from the import graph.
A separate **design-system** job runs `design:typecheck` and `design:check` after
types/unit tests. A separate **rust-clippy** job runs the pinned Clippy over the
whole Cargo workspace with the same invocation as the `native` CI lane
(`cargo clippy --workspace --locked --all-targets -- -D warnings`); Rust-only
changes do not run the JS/test lane, and its first cold build can take minutes.
The jobs are serialized because Lefthook shares a mutable stdin reader between
jobs: parallel consumers can lose Git refs and silently skip checks. Source CSS/JS/TS, design viewer/guard files, shared
configuration/dependencies and hook-runner changes select this job; a missing base
runs it conservatively. Its selection is independent of the unit-test skip, so
CSS-only and viewer-only errors still block a push. The Clippy lane is likewise
selected independently: Rust source (`crates/`, `src-tauri/`), the workspace
manifests/lockfile, Clippy or Rust toolchain configuration, and changes under
`bin/` (the pinned toolchain) select it. Documentation-only pushes skip all
three jobs. Every selected job must pass.
On a busy machine, set `BUZZ_TEST_WORKERS=2 git push` to limit Vitest worker
concurrency in the hook. The optional value must be a positive integer; leaving
it unset preserves Vitest's default. This also applies to direct Vitest runs and
does not change test selection, timeouts, assertions, or retries.

Neither the JS nor design job fetches, installs dependencies, formats, or starts
browsers; the design job disables pnpm dependency auto-repair. The Clippy job
runs no builds beyond Clippy's own check pipeline, no tests and no browsers;
its first cold run downloads dependencies and can take minutes. Install
dependencies when switching branches, not during a push.

This is advisory coverage of the current working tree, not a replacement for CI:
uncommitted edits can affect results, dynamic dependencies may not be selected,
and non-HEAD refs are explicitly left to CI. Type errors, design violations, test
failures and Clippy warnings block the push. The type checks use `tsconfig.json` and
`tsconfig.design.json`; they do not typecheck plain JavaScript browser tests or
prove runtime service provisioning.
Do not edit files concurrently with hooks. First-use Hermit tool downloads can
add setup time; normal warm hooks use the pinned tools already installed.

## Pull-request CI

`.github/workflows/ci.yml` runs on every PR and push to `main`, without path filters
that could omit newly added tests. It splits the CI-selected `scan` coverage
across cached, parallel jobs rather than running the entire recipe several times.
[Three documented WebKit cases remain local-only](browser-testing.md#ci-coverage-and-local-only-webkit-checks);
the complete correctness suite still runs with `pnpm test` / `just scan`:

- **JavaScript:** four runners, each with Biome, one TypeScript check and a frontend
  build. Vitest splits all test files across the runners, with two workers each;
  every shard must succeed. Timing artifacts include the shard number.
- **Rust and tool integration:** workspace formatting, Clippy, all Rust tests and
  doctests (including Tauri), and every Node integration test. The CLI integration
  tests build Rust and install scaffold dependencies; they are intentionally CI-only
  rather than part of pre-push.
- **Browser measurements:** Chromium then WebKit, serially on an isolated runner.
  It also runs all [perf scenarios](performance.md) once in Chromium.
- **Browser journeys:** twenty-seven runners (nine Chromium and eighteen WebKit
  file-level shards), each with two workers. They start alongside measurements on separate
  runners; `CI required` still requires both lanes. A separate required Ubuntu
  job builds the native plugin-manager fixture once with Hermit's pinned Cargo.
  It uploads a tar with executable permission, checkout revision and SHA-256
  checksum; shards download by exact same-run artifact ID and verify all three
  before running. A missing artifact fails CI rather than rebuilding; the artifact
  is kept for seven days, so failed shards can be re-run within that window. Local
  non-CI journeys retain the locked Cargo build. Each browser test uses its own
  mutable fixture home. No measurements are repeated on shards and no retries
  hide failures.
- Both browser lanes use the version-matched, digest-pinned
  [Playwright Docker image](https://playwright.dev/docs/docker), which supplies
  browsers and Linux libraries without per-job apt provisioning. Follow the
  [CI container guidance](https://playwright.dev/docs/ci#via-containers).
  Update both image references and digests when upgrading `@playwright/test`.
  Setup verifies installed Playwright against image metadata and launches the
  selected engine (both for measurements) before tests; it never downloads a
  missing browser. Hermit pins Node/pnpm through explicit `./bin/` entry points
  and fails closed if the pnpm store path cannot be resolved. Containers use
  `HOME=/root` and trust only their exact checked-out workspace. Native host
  jobs keep their normal toolchain and library setup.
- **Flake check (advisory):** on pull requests, `scripts/flake-check.mjs select`
  maps the diff against the base branch to the Vitest tests and Playwright
  journeys it changed (`file:line` for hunks inside a test body; the whole file
  when the diff touches any line outside one, such as imports, helpers or hooks
  before, between or after tests, or the file is new; removed lines are judged
  against the base revision's test bodies). Those always run. It then adds
  whole test files that the diff's other source, helper, fixture-page or patch
  changes reach, most specific first, while each lane's predicted wall time
  stays within nine minutes and the additions stay near 40 journeys and 20
  Vitest files. A Vitest file that would overrun the time is skipped, and
  files after it can still join; the step summary names the highest-ranked
  skipped files.
  Journeys run as the longest run in rank order that fits, since more
  journeys can mean more shards and a shorter lane. Two gaps remain: a journey
  that loads the full app (`page.goto(app.origin)`) is reached only through
  modules its own imports reach, such as helpers, not through the app's module
  graph; and a patch under `patches/` reaches browser specs but no Vitest
  files. When a change touches such code, run the related tests yourself.
  The prediction reads
  per-journey and per-file durations from
  `scripts/flake-check-costs.json`; `scripts/flake-check.mjs costs` regenerates
  it from recent green `main` runs. `flake_vitest`
  then runs that selection ten times with the JavaScript lane's two workers, and
  `flake_browser` runs `--repeat-each=10` per engine (Chromium and WebKit)
  on the shard container with the same native fixture, spreading the
  repetitions over one shard per five journeys (at most sixteen) so a whole-file
  selection fits the job timeout. Measurement specs and
  journeys tagged `@classic-scrollbars`, `@local-webkit` or `@media-recorder`
  are excluded; their own lanes cover them. The step summary shows a test ×
  iteration table. The lanes skip when no test changed and report as their own
  statuses, outside `CI required`.
- **CI required:** fails unless every automatic Linux lane and every browser shard succeeds,
  including cancellation or an unexpectedly skipped lane. Configure this status
  as a required repository check; the workflow does not change branch protection.

Actions and tool versions are pinned, installs use the frozen lockfile, and
Hermit/pnpm/Cargo caches avoid repeat downloads and cold compilation.
Superseded PR runs are cancelled. Automatic CI uses disposable Ubuntu runners and no live
Buzz identity or signing credentials. It is not native GUI acceptance, a signed
package, or a cross-platform release gate. `just scan` remains available locally;
CI does not add full scans to commit/push or ordinary interactive feedback rounds.

### On-demand Windows validation

Automatic PR/main CI is Linux-only. Run the existing workflow manually for native
Windows changes or release validation:

```sh
gh workflow run ci.yml --ref <branch>
```

A manual dispatch runs only **Windows native validation**: the same pinned Rust,
Clippy and complete Tauri, agent-controller and credential-store package tests,
without repeating Linux/browser jobs.
Windows failures do not block the automatic `CI required` check; a Linux pass
is not Windows validation. The job does not exercise OS banner interaction or
packaged-app acceptance.

For MSVC, `src-tauri/build.rs` links `windows-app-manifest.xml` into both the app
and library unit-test executables. The XML matches Tauri's default Common Controls
v6 manifest; icons/version resources remain Tauri-owned. This addresses
[Tauri's library-test manifest gap](https://github.com/tauri-apps/tauri/issues/13419)
without disabling IPC tests or native UI features. Non-MSVC builds retain Tauri's
default resource path. Keep the manifest aligned when upgrading Tauri.

## Test organization

Keep component and service tests beside their owner, including integration tests
that belong to one subsystem. Use Vitest for these tests (`*.test.ts`,
`*.test.tsx`, or existing `*.test.mjs`); JavaScript tests do not need a TypeScript
rewrite just to move. `vitest.config.ts` discovers tests under `src/`,
`browser-host/` and `scripts/`. Tooling tests stay beside their scripts.

- `src/app/pages.integration.test.mjs` exercises the actual bundled app composition;
  `src/plugins/runtime.test.mjs` covers plugin activation and disposal.
- `browser-host/relay-broker.test.mjs` lives beside the Node-only development broker. Other
  broker integration tests remain with the community/relay behavior they exercise.
- `tests/integration/` is for cross-system journeys. The plugin CLI test keeps
  Node's runner because it builds the Rust CLI, scaffolds a separate project, runs
  its build and installs the resulting module.
- `tests/browser/` contains the automated whole-app Chromium/WebKit journeys.
- Rust integration tests stay under their owning crate's `tests/` directory.

`pnpm test` runs all four layers: Node integration, Vitest, Rust plugin-manager,
then Playwright. Updating a test's location must also update discovery, imports,
fixture URLs and root-path calculations; moving a file must not silently drop it
from the gate.

### Choosing a test layer

Choose the cheapest layer that can observe the failure, not the tool used by the
last test in the feature. Regression coverage is about behavior, not test counts
or a coverage percentage. These rules apply to human and AI contributions alike.

| Contract | Default layer |
| --- | --- |
| Parsing, policy, state machines, protocol handling, service coordination | Vitest in Node; use real collaborating services where the boundary matters |
| Component state, effects, subscriptions, forms, semantic DOM and stale async results | React Testing Library in Vitest with jsdom |
| Layout, virtualization, scrolling, native editing/focus interactions, real browser storage coordination | Playwright in both engines |
| App composition across routing, plugins, transport and persistence | Representative Playwright journeys, with permutations in lower layers |

Run JS tests with `bin/pnpm exec vitest run`, optionally followed by a test path.
For mounted component tests, add `// @vitest-environment jsdom` at the top of the
colocated test and import `@testing-library/jest-dom/vitest` for DOM assertions.
Use real React (including StrictMode), role/label queries and `userEvent` for
interactions. Use `fireEvent` for deliberately low-level events or bulk input
whose keystrokes are not the contract. Unmount with RTL `cleanup` in `afterEach`;
clear owned storage and restore spies. Fake external services, not React hooks.
Keep snapshots stable until a service actually changes, and assert cleanup and
late-result rejection through real mounting, rerendering and unmounting.
See the [composer tests](../src/features/messages/MessageComposer.test.tsx).

jsdom is the default DOM emulator, not a second browser gate. Its
[standards-oriented implementation](https://github.com/jsdom/jsdom#readme) and
compatibility with Testing Library favor behavioral fidelity over emulator-only
speed claims. [Vitest supports Happy DOM too](https://vitest.dev/guide/environment),
but introducing another emulator requires a demonstrated benefit on our actual
component tests without per-environment workarounds. Neither proves rendering,
native IME behavior or browser performance. Keep layout shims local and explicit;
do not treat synthetic dimensions as acceptance evidence.

Before accepting test changes, reviewers should verify:

- Each added browser case identifies a browser-specific behavior or integration
  boundary that a lower layer cannot establish. Keep failure/recovery coverage,
  but avoid repeating the same state matrix through full app startup.
- A moved assertion has a named replacement and evidence that a plausible defect
  makes it fail. Similar test titles do not establish equivalent coverage.
- Fixture data matches the test's needs. Share stateless servers/compiled assets,
  not browser contexts or mutable state; keep scale tests representative.
- Timing claims distinguish setup, execution, runner/engine and the checked
  snapshot. Report added/removed cases and deferred checks. Do not impose a
  flaky wall-clock threshold on ordinary correctness tests.

Follow `AGENTS.md` to record those decisions in the PR description and enforce
them during agent review. Request a lower-layer test when the browser justification
is missing, rather than accept unbounded journey growth. Existing broad fixtures and hook-mocked tests are
migration work, not patterns for new tests; convert them by owner without
bundling unrelated product changes.

### Manual browser fixtures

With `just web` running **without a `BUZZ_DEV_VIEWER` pin**, these separate diagnostic pages
use fixture identities/transports rather than the live broker:

| URL | Purpose |
| --- | --- |
| `/tests/fixtures/communities.html` | Local profile and join dialog; first profile publication deliberately rejected |
| `/tests/fixtures/relay-composer.html` (optional `?durable`) | Delayed signing/publication and one-time rejection for messages containing `reject` |
| `/tests/fixtures/relay-storage.html` | Real IndexedDB migration, signed restore, deletion and partition isolation |
| `/tests/fixtures/relay-startup.html` | Cold/warm send timings with 512 retained signed records |

These pages are manual diagnostics, **not automatically run by `pnpm test`**.
The scrolling gate does not replace their checks. Use a disposable browser profile
for their local storage; timings are diagnostics, not production guarantees.

## Foundation files

The standard source comment is `FOUNDATION: <responsibility and constraint>`.
Agent instructions for these files live in `AGENTS.md`: edits require explicit
human guidance, and foundation files have stricter code review standards.
