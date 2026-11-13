# Desktop releases

## Agent protection compatibility notice

Builds with agent protection require explicit native owner confirmation before
upgrading local agents to the one-way protected storage format. **Every local
agent becomes inaccessible to older Buzz builds**, including an installed app
sharing the development build's store. Clearing protection does not undo this.
Close other Buzz builds before confirming and retain a compatible build. Cancel
leaves files unchanged; earlier protected previews prompt at startup. See the
[upgrade and recovery contract](agent-protection.md#local-storage-upgrade).

## Preview channel (opt in)

Previews are an opt-in early-access channel. Each build has one updater feed
compiled in, and the app keeps no channel setting: the build you install decides
where it updates from. Preview builds check the
[preview feed](#preview-updater-feed-automatic-promotion-manual-recovery);
stable releases check the [stable feed](#stable-updater-feed).

- **Join:** install a preview (a prerelease named `Buzz X.Y.Z-preview.N`)
  from the [Releases page](https://github.com/block/buzz-app/releases). From then
  on the app updates to each new preview.
- **Leave:** install the release marked **Latest** from the same page. From then
  on the app updates only to stable releases. This installs an older version
  over a newer one: a preview may have changed local data in a way the older
  stable build cannot read (see the
  [agent protection notice](#agent-protection-compatibility-notice)).

A preview of `main` is built every day, and again right after each stable
release is published. Stable tags are always in `main`'s history, so that
preview includes the release, and preview installs get its code without
leaving the channel.

## Preview artifacts

The **Desktop previews** workflow (`release.yml`) builds all supported desktop
platforms and publishes one GitHub prerelease, tagged
`v<version>-preview.<N>` at the built commit. The
build, verification, updater signing and publication jobs live in the reusable
`desktop-build.yml`, which [stable and beta releases](#stable-and-beta-releases)
share, so every lane publishes the same assets:

- **Apple Silicon and Intel macOS:** a signed/notarized DMG and a signed updater
  archive with its `.sig` for each architecture.
- **Windows x64:** unsigned NSIS `.exe` installer and its updater `.sig`.
- **Linux x64:** Ubuntu 24.04 `.deb` and AppImage, each with its updater `.sig`.
- **Provenance:** `SOURCE_COMMIT` and one `SHA256SUMS` covering all twelve asset files.

Publication waits for every platform job, their existing payload checks and
the Windows/Linux updater signatures. A failed platform blocks publication and
automatic feed promotion; it does not publish a partial release. Downloads are
checked against each job's checksums before assembly. If a job fails, use
**Re-run all jobs**. The re-run works out the number again from the tags that
exist at that moment, so it gets the same version only if no other preview has
published since; publication still rejects artifacts built as any other version. Windows/Linux previews are not
Authenticode-signed Windows releases or evidence of completed desktop acceptance.

Previews build from three triggers:

- **Daily**, from `main`'s head (09:37 UTC).
- **After each stable release.** When **Desktop stable release** succeeds for a
  `vX.Y.Z` tag, the workflow builds `main`'s head, which includes that release.
  Betas start no preview.
- **By hand**, from `main`'s head:

  ```sh
  gh workflow run release.yml --repo block/buzz-app --ref main
  ```

The version is set automatically, once per run, before any platform builds:
one patch above the highest stable `vX.Y.Z` tag in the built commit's history,
then `-preview.<N>`. `N` is one above the highest existing
`v<base>-preview.<N>` tag (compared numerically), or 1 if there is none, so it
counts published previews of that base and starts over with each new base.
After `v1.0.1`, previews are `1.0.2-preview.1`, `.2`, `.3`…; after `v1.1.0`,
`1.1.1-preview.1`, and so on. A daily run, the run after a stable release and
a manual run each take the next number. A run takes its number once its tag
exists, even if promotion or cleanup fails afterward; a run that fails before
publishing creates no tag and takes none.
`tauri.conf.json`'s version is not used, and beta and preview tags never count.
A run whose commit has no stable tag in its history fails. By SemVer
precedence a preview sorts above the stable release it follows and below the
next one (`1.1.0-preview.9` < `1.1.0` < `1.1.1-preview.1`), and `N` orders
previews of the same base. Runs share one concurrency group, so two previews
never compute the same number; candidate runs compute one but never publish.
Cleanup keeps the newest 10 previews overall, so the current base's highest `N`
is never deleted. It can delete every tag of an older base, though; a full
re-run of an old run from that base may then reuse one of its numbers, and the
feed refuses to promote it. Older `-preview.<run>.<attempt>` previews are left as they are.

The macOS builds run on Apple Silicon `macos-latest` with the repository's
pinned toolchain; the Intel build cross-compiles `x86_64-apple-darwin` after
adding that target's standard library to the pinned Rust release. Each
publishes an Apple-signed/notarized DMG and a separately Tauri-signed updater
`.app.tar.gz` and `.sig`. The updater archive is rebuilt from the verified app
in the signed DMG; built-in Tauri artifact creation remains disabled because
this DMG-only build does not emit an updater archive.

Windows and Linux installers are built with the same updater configuration.
Their jobs never receive the Tauri signing key: each checks that its installed or
extracted app executables embed the pinned public key and preview endpoint (and,
on Linux, the deb or AppImage bundle type the updater uses to choose its feed entry),
then uploads the installers. A separate `updater_signatures` job verifies their
checksums and Tauri-signs those exact bytes. The updater runs the downloaded NSIS
installer on Windows (current-user, no elevation), replaces the AppImage in place,
and installs a deb with `dpkg -i` through `pkexec`, which asks for an
administrator password.

The release automatically promotes each eligible build to the rolling preview
feed after the signed prerelease is published and the promotion gate passes.
An updater-less artifact, invalid signature, or rollback leaves the existing feed
unchanged, but the promotion job fails and needs investigation. The workflow
does **not** publish to the legacy `block/buzz` updater. Older installed apps
cannot use the feed until an updater-enabled build is installed. Preview builds
for all three platforms are built with the updater enabled and check the preview
endpoint below.

## Preview updater feed (automatic promotion, manual recovery)

The preview endpoint is `https://github.com/block/buzz-app/releases/download/preview-feed/latest.json`.
This is a dedicated rolling prerelease in `block/buzz-app`, separate from legacy
`block/buzz`'s `buzz-desktop-latest`. Stable releases use their own
[stable feed](#stable-updater-feed); this workflow never writes it. Neither
endpoint is `releases/latest`, which serves the Latest stable release's assets.

**Auto-promotion begins as soon as this workflow lands on `main`.** Install an
updater-enabled build manually first (older installed builds lack the updater),
and verify its embedded public key and preview endpoint match the release
configuration. The macOS build job checks those values in both the Apple
Silicon and Intel binaries, promotion rechecks only the Apple Silicon binary,
and the Windows/Linux build jobs check their binaries, but nothing validates a
live old→new install before publishing. For manual recovery or a controlled
repromotion, dispatch an existing version from `main`:

```sh
gh workflow run release.yml --repo block/buzz-app --ref main \
  -f promote_version=1.0.2-preview.<N>
```

After the first eligible build publishes, exercise discovery, signature
verification, download, install, relaunch/version, and absent-feed and
mismatched-key handling on disposable clients before expanding preview
distribution. There is no safe way to perform a live old→new check against
the fixed URL without first exposing a candidate to clients already pointed
there. Restrict distribution until that check succeeds.
The release build must embed the same pinned public key and preview endpoint as
#312; promotion verifies both in the candidate macOS executable. Builds made before
that integration are ineligible even if their updater archive and signature
exist, as are builds without Windows/Linux signatures. The promotion gate
(`scripts/promote-updater-feed.sh`, shared with the stable feed) downloads every
updater artifact and signature, verifies the Minisign archive and trusted-comment
signatures against the client's pinned key. The release signer signs the
archive and trusted comment without passing
`--app-version`, so signatures do not embed an authenticated version. The gate
accepts that format and verifies both signatures, but cannot bind the advertised
feed version to those signed bytes.
A feed-response attacker can replay an older authentic archive/signature under
a higher advertised version. Preview distribution must accept that residual
risk until a separate signing migration passes `--app-version`, enables
`requireSignedVersion`, and requires the same version at promotion. The CLI
2.12.2/updater 2.13.3 dependency upgrade leaves this migration deferred. Do not
enable the client flag alone: existing unbound signatures would fail. A signature
mismatch fails before the rolling manifest is replaced.

The job builds the Tauri manifest with each artifact's signature from that
release and an immutable versioned asset URL: `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`,
`linux-x86_64-deb` and `linux-x86_64-appimage`. Linux has no generic entry, so
a deb install never receives an AppImage. The job refuses full-SemVer rollback and
changed same-version metadata, and replaces the rolling manifest last. The preview
feed may hold a stable `X.Y.Z` (for example, one preview installs were moved to);
a preview replaces it only when it sorts above it, so `1.0.2-preview.N` replaces
`1.0.1` and `1.0.1-preview.N` is refused as a rollback. The stable feed never
accepts a preview. The
archive and signature remain on the versioned release. The job reads back
and compares the GitHub API asset; this is not evidence of public endpoint
availability. Confirm the endpoint in an installed client after the first
promotion. GitHub asset replacement can briefly return 404 while the old asset
is replaced. Promotion is serialized with the release workflow, and a failed
upload needs investigation before the next preview run.
Recover from a broken feed by promoting a higher tested build; for key loss or
client failure, distribute a manually installed build (an Apple-signed DMG on macOS). Do not assume
rolling back a signed archive can undo an installed update.

## Preview retention

After successful promotion and feed read-back, the same serialized job removes
old versioned preview releases **and their Git tags**, keeping the union of:

- the latest **10 published previews**, ordered by publication time;
- every preview published within the last **seven days** (including the boundary);
- the preview currently referenced by `preview-feed/latest.json`.

Cleanup only considers non-draft prereleases with canonical
`v<version>-preview.<N>` tags. Stable releases, other tag formats (including
old `-preview.<run>.<attempt>` previews), and the rolling `preview-feed` release are never deleted. The feed is
read again before cleanup; an unavailable/invalid feed, missing target, failed
listing, or invalid preview publication date aborts before deletion. A deletion
failure stops cleanup and fails the job, without rolling back the promoted feed;
inspect the release/tag state before rerunning. Cleanup also runs after successful
manual promotions, but never after failed promotion or Windows/Linux candidates.

To inspect the current plan without deleting anything, from an authenticated
checkout:

```sh
GH_REPO=block/buzz-app bin/node scripts/prune-preview-releases.mjs
```

The workflow passes `--apply` to execute the plan. Removed release download links
stop working; clients holding a removed version's download URL must check the feed
again. The age window is measured from publication, not promotion. Actions build
artifacts have a separate seven-day retention policy and do not control GitHub
release retention.

## Stable and beta releases

Public releases for people outside the team are published from protected
`vX.Y.Z` (stable) and `vX.Y.Z-beta.N` (beta) tags by the **Desktop stable
release** workflow (`desktop-stable.yml`). They use the same build, checks,
twelve assets and `SHA256SUMS` as previews, with two differences:

- The version is the tag's (`v1.0.0` builds `1.0.0`), not `tauri.conf.json`'s.
- Every platform embeds the same updater public key as previews, but the
  stable feed endpoint
  `https://github.com/block/buzz-app/releases/download/stable-feed/latest.json`.
  Each build job checks its executables for that endpoint.

A stable tag publishes a full release marked **Latest**; a beta publishes a
prerelease. Both publish on the existing tag (`--verify-tag`) and never create
or move one. Previews' own tags (`v…-preview.N`) and the internal
`desktop-v*` tags described below never start this workflow.

The workflow first refuses, before building, unless:

- the tag is exactly `vX.Y.Z` or `vX.Y.Z-beta.N` (no leading zeros, `N` ≥ 1);
- an active tag ruleset restricts `refs/tags/v*` (see [setup](#stable-release-setup));
- the tag points at the run's commit, and that commit is in `main` history.

To release, an admin tags a commit in `main` history and pushes the tag with
Git. Do not create the tag from the GitHub Releases page: that creates the
release first, and the workflow then fails because the release already exists.

```sh
git fetch origin main
git tag -a v1.0.0 -m 'Buzz 1.0.0' <commit-sha>
git push origin refs/tags/v1.0.0
```

If a platform job fails, use **Re-run all jobs**, as for previews. A published
tag is never moved or reused; cut a new version instead. Publishing a stable
release also starts a [preview](#preview-artifacts) of `main`, which includes
the release and is versioned above it; nothing needs bumping by hand.

### Stable updater feed

Publishing a release never changes what installed apps receive. To serve a
published stable release, run **Desktop stable feed** (`desktop-stable-feed.yml`)
from `main`:

```sh
gh workflow run desktop-stable-feed.yml --repo block/buzz-app --ref main \
  -f version=1.0.0
```

It waits for approval in the `desktop-stable-feed` environment, and fails unless
that environment has required reviewers and deploys only from `main` (GitHub
creates a missing environment without protection). It then runs the preview
feed's promotion gate against the stable feed: it requires a published,
non-draft, non-prerelease `v1.0.0`, verifies every updater signature against the pinned
key and the stable endpoint in the Apple Silicon executable, refuses rollback
and changed same-version metadata, replaces `stable-feed/latest.json` last and
reads it back. Only `X.Y.Z` versions can be promoted, so betas and previews
never reach the stable feed; beta installs update to the next promoted stable
release. The `stable-feed` release is created as a prerelease, so it never
becomes Latest. Preview cleanup ignores stable and beta releases and the
`stable-feed` release.

The first promotion creates the feed. Before announcing automatic updates,
install that release, then promote a newer one and check that the installed app
updates on each platform. The preview feed's residual risks apply unchanged,
including unbound signature versions.

### Website installer manifest

After the stable feed is replaced and read back, the same approved job publishes
`downloads.json` to the dedicated `download-feed` data branch, so the website
offers the release installed stable apps receive. Previews and betas never
change it. Its public URL is:

`https://raw.githubusercontent.com/block/buzz-app/download-feed/downloads.json`

Schema version 1 contains `channel: "stable"`, `version`, `release` and a
`downloads` map with `macos-arm64`, `macos-x64`, `windows-x64`, `linux-appimage`
and `linux-deb` URLs. Mac entries are DMG installers, not updater archives.
All five exact, nonempty assets of the published, non-prerelease release must
exist before the manifest changes. Publication follows `stable-feed/latest.json`,
rejects rollback and altered same-version metadata, uses an atomic file update,
and verifies read-back. The first stable promotion creates an orphan branch
containing only the manifest; until then the URL returns 404. Keep that branch
writable by release Actions; no personal token or Pages setup is required.
Raw-file CDN updates can take about five minutes to become visible.

Manifest generation for the promoted stable release can be checked without
writing anything:

```sh
GH_REPO=block/buzz-app bin/node scripts/publish-desktop-downloads.mjs 1.0.0
```

For recovery, a release operator can run the same command with `--apply` for the
currently promoted stable version. Stable releases are never pruned, so the
advertised installers stay available. Website clients should use bounded caching
and fall back to the releases page if metadata cannot be read or validated. This
manifest selects installer links; it is not an updater signature or desktop
acceptance record.

### Stable release setup

A repository admin sets these up once, before the first stable tag:

- **Order.** Activate the tag ruleset before this workflow is on `main`, and
  check then that no stable or beta tags (`vX.Y.Z`, `vX.Y.Z-beta.N`) exist yet.
  The workflow checks only that the ruleset is active when it runs, so a tag
  created before then would publish, or re-run, without the ruleset ever having
  governed its creation.

- **Tag ruleset.** Create a second tag ruleset, separate from the
  `desktop-v*` one below (whose tag workflow requires it to have no exclusions):
  - target tags, enforcement **Active**;
  - include `refs/tags/v*` and exclude `refs/tags/v*-preview.*`;
  - restrict creations, updates and deletions, and block force pushes;
  - bypass: the repository admin role, in `always` mode.

  The exclusion matters. The previews workflow creates each `v…-preview` tag
  through `gh release create` with `GITHUB_TOKEN`, and preview cleanup deletes
  old ones the same way. `GITHUB_TOKEN` is not a bypass actor, so a ruleset over
  all of `refs/tags/v*` would fail every preview publication and cleanup. Do
  not add GitHub Actions as a bypass actor instead: any workflow on any branch
  could then create a stable tag. With the exclusion, preview tags stay as
  unprotected as they are today; the stable workflow ignores them.

- **Environment.** Create `desktop-stable-feed` with required reviewers and a
  custom deployment branch policy that allows only the `main` branch. It holds
  no secrets. Promotion checks both and refuses to run without them.
- **Signing.** Stable builds use the [signing secrets](#signing) previews use.
  The macOS signing role must trust this repository's tag runs as well as
  `main`: confirm its OIDC trust policy accepts `refs/tags/v*` before the
  first stable tag.

## Release tags

Release builds outside this repository's GitHub Actions consume immutable
`desktop-vX.Y.Z` or `desktop-vX.Y.Z-beta.N` tags, never a branch or commit.
These are separate from the public [stable and beta](#stable-and-beta-releases)
`v*` tags: they never start a GitHub Actions build.
Run **Desktop release tag** from `main` with the version and a full commit SHA
in `main` history. It publishes an annotated tag through the release GitHub App
and fails before writing unless an active tag ruleset includes
`refs/tags/desktop-v*`, has no exclusions, restricts creation, update, deletion
and non-fast-forward, and lets the App bypass it. A published tag is never
moved or reused; cut a new version instead.

Until the App exists, that ruleset's only bypass actor is the repository admin
role, and an admin creates each tag by hand on a commit in `main` history:

```sh
git fetch origin main
git tag -a desktop-v0.7.0-beta.1 -m 'Buzz desktop 0.7.0-beta.1' <commit-sha>
git push origin refs/tags/desktop-v0.7.0-beta.1
```

Setup, by a repository admin:

- Install the release App and create a `desktop-release-tag` environment that
  deploys only from `main`. Put the `BUZZ_RELEASE_TAGGER_CLIENT_ID` variable and
  `BUZZ_RELEASE_TAGGER_PRIVATE_KEY` secret in that environment, not the repository.
- Make the App the ruleset's only bypass actor, in `always` mode. The
  workflow cannot see the bypass list, so confirm it before the first tag and
  after any ruleset change.

## Prerequisites

### Builderlab URL

The desktop build leaves `BUZZ_BUILDERLAB_URL` unset, so every platform build,
in every lane and including candidate-only runs, signs in to the built-in
Builderlab server (`https://app.builderlab.xyz`) with the native session. When
the repository's non-secret Actions variable
`BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG` is nonempty, the workflow adds its
servers to the built-in one; see
[federated identity build input](configuration.md#federated-identity-build-input).

### Signing

Set these repository Actions secrets:

- `OSX_CODESIGN_ROLE`: ARN of the IAM role the signing action assumes.
- `CODESIGN_S3_BUCKET`: the signing action's artifact bucket.
- `TAURI_SIGNING_PRIVATE_KEY`: persistent Tauri updater private key (not the
  Apple Developer ID signing identity). Restrict access to release CI and back
  it up outside Actions; losing it prevents old updater-enabled builds from
  trusting new releases.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: password for that key.

Keep the matching updater public key in updater-enabled app builds. Rotate only
with a planned transition/recovery path (a manually installed signed DMG if
necessary); changing the key alone strands existing installations. Do not
publish a preview `latest.json` until its archive and signature are available
at stable HTTPS URLs. Verify old-build → new-build installation promptly after
the first eligible auto-promotion, before wider preview distribution.

## Bundled goose-acp

Every package ships `goose-acp` in its `bin` resources, so Goose agents need no
install. `scripts/build-goose-acp.mjs` downloads the upstream standalone release
pinned in `runtime/goose-acp.json`. These use Goose's `lean` profile and
`rustls-tls,system-keyring,online-model-meta` features (about 15 MB on macOS).
`tauri build` runs the script through `beforeBuildCommand`; `just desktop` uses
the same release bytes (`--dev` remains accepted). The script selects
`TAURI_ENV_TARGET_TRIPLE` or the host reported by `rustc -vV` (matching Cargo,
including under Rosetta) and rejects unsupported targets.
The pin covers macOS and Linux ARM64/x64 and Windows x64 MSVC.
The upstream macOS executable requires macOS 12.0; Buzz's packaged minimum is
12.0 too, raised from the previous source build's 11.0 deployment target.

Downloads are cached under `target/goose-acp-download`. Every run checks the
archive SHA-256 before reading its sole expected executable member, then repairs
missing or changed staged bytes by atomic replacement. No source checkout or
Goose Rust compilation is needed. Native hosts need `tar` (Windows explicitly uses
`%SystemRoot%\System32\tar.exe`, avoiding Git Bash's GNU tar on PATH);
cross-staging Windows on Unix also needs `unzip`. macOS staging retains the
system-library check. The app's own signature covers the executable; nothing
else checks it at launch. Each release job checks package presence.

To update Goose, verify every target archive against the exact release identity:

```sh
gh attestation verify <archive> --repo aaif-goose/goose \
  --signer-workflow aaif-goose/goose/.github/workflows/release.yml \
  --source-ref refs/tags/v1.59.0 \
  --source-digest 5d03ef6ed07ba59826328f1aff18d9a754ff8ad2 \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --deny-self-hosted-runners
```

Then update version, source revision, versioned asset URLs and SHA-256 values
together, and review upstream license/notice changes. Move the Buzz Security
plugin's protected Goose pin to the same revision before that Buzz release
ships. This release is mutable; committed hashes bind the downloaded bytes.
Never resolve
`latest` at build time.
The obsolete `target/goose-acp-src` and `target/goose-acp-build` caches are unused
and can be removed locally when no old source build is running.
Version 1.59.0 advances Goose 18 commits from v1.58.1; the four commits only on
v1.58.1's release branch are release chores and cherry-picks of #13328 and
#13340, both included in v1.59.0; distribution parity alone does not
establish runtime compatibility. Before
shipping, exercise provider sessions, HTTP MCP, steering/cancellation, secret
non-persistence and session history, plus native Windows/Linux startup and
packaged signing/installers.
The candidate is known to fail the MCP credential non-persistence check: the
client HTTP URL and bearer header are stored in session data and export.
An isolated canary probe reproduced this in both the old source-built 1.56.0
executable and v1.57.0; upstream #12908 was closed unmerged, so v1.59.0 does
not include it either. This
remains a separate existing acceptance failure, not a distribution regression.

## Bundled buzz CLI

Every package ships the `buzz` command line client (about 12 MB on macOS) in its
`bin` resources, so nobody builds it from source. On macOS the path is
`Buzz.app/Contents/Resources/bin/buzz`; Windows ships `bin\buzz.exe`. It cannot
live in `Contents/MacOS`: on a case-insensitive volume that name is this app's
own `Buzz` executable (see `legacy_cli_shortcut.rs`).

`scripts/build-buzz-cli.mjs` runs `cargo install --git ... --rev ... --locked
buzz-cli` for the revision in the `buzz-audio-client` dependency of
`src-tauri/Cargo.toml`, so one pin selects both the audio client and the CLI;
bumping that revision updates both. The build uses block/buzz's own
`Cargo.lock`, not this repository's, with stripped release symbols. `tauri
build` runs it through `beforeBuildCommand`; `just desktop` runs it with `--dev`
(a debug build, and a failure only warns). It selects `TAURI_ENV_TARGET_TRIPLE`
or the host, installs under `target/buzz-cli/<rev>/<target>/<profile>`, which
lets Cargo skip an install that is already current, and replaces the staged file
atomically. Each revision also builds in its own `target/buzz-cli-build/<rev>`:
Cargo trusts an earlier build of a git checkout even after the revision changes,
so a shared build directory would stage the old CLI after a bump. Linked
worktrees use the main checkout's `target/`, so they share one build of each
revision. A first release build takes about two minutes.

The macOS release signing service signs the executable with the Developer ID
certificate and the hardened runtime, as it does `goose-acp` and
`buzz-agent-command`; `buzz` links only system libraries and needs no
entitlement. The release job verifies the signature and runs the signed
`buzz --help`; the Windows and Linux jobs run the installed executable too.
`scripts/test-buzz-cli.mjs` (CI) stages a debug build and runs `buzz --help`.

The app does not put `buzz` on `PATH`. Users and agents call it by absolute path
or link it themselves:

```sh
mkdir -p ~/.local/bin
ln -sf /Applications/Buzz.app/Contents/Resources/bin/buzz ~/.local/bin/buzz
```

The CLI ships with the app and updates only with it. It is built from the pinned
revision, not from the relay's current version, so a relay newer than that
revision can accept protocol changes that the bundled CLI does not know.

## Windows and Linux installers and candidate-only runs

The same **Desktop previews** workflow has a manual `candidates` switch. It builds
unsigned Windows x64 NSIS `.exe` and Ubuntu 24.04 x64 `.deb`/AppImage artifacts,
without running macOS signing or the release publisher:

```sh
gh workflow run release.yml --repo block/buzz-app \
  --ref <candidate-branch> -f candidates=true
```

Dispatches without this switch build and publish all three
platforms. A `promote_version` recovery run skips all platform builds and only
updates the feed. Candidate-only runs remain artifact-only, are built without the updater, and can run from
a feature branch, without signing credentials or publication. They use the same
preview version, source commit and repository toolchain pins; they never
use legacy Buzz's sidecars, updater feed, application identifier, or signing
secrets. The workflow records
`SOURCE_COMMIT` and checksums over final installer bytes. Download the
`windows-x64-candidate` and `linux-x64-candidates` artifacts from that Actions run
within seven days. These are **ready to try only after their build and payload
checks pass**, not accepted releases.

Windows uses the repository's Rust, Node and pnpm pins on the hosted MSVC runner
because Hermit does not run there. NSIS retains Tauri's current-user install and
WebView2 download-bootstrapper defaults (network needed if WebView2 is absent).
The job silently installs into a disposable runner directory and verifies the
installed app executable, without launching the app.

The Windows config pins `bundle.publisher` to `local`, the publisher Tauri derived
from the identifier before 1.0, so an update still finds the install folder Tauri
records under `Software\local\Buzz Foundation`. An update keeps existing shortcuts,
so `src-tauri/installer-hooks.nsh` gives the Start menu and desktop shortcuts the
current identifier as their AppUserModelID, which Windows shows notifications under.

Linux reuses old Buzz's Ubuntu 24.04 recipe and guarded Wayland/GStreamer AppImage
repair from `block/buzz` tag `desktop-v0.5.25`. Repacking tools and the type2 runtime
are checksum-pinned. The workflow verifies the app executable in the extracted deb
and the app executable and launch shim in the extracted AppImage after repacking.
Compatibility guards fail rather than silently omitting a fix.
AppImage still relies on host desktop/media libraries; this is not a promise of
universal distro compatibility. Neither candidate job writes shared build caches.

### Acceptance still required

Use disposable Windows 11 and Ubuntu 24.04 GNOME accounts with throwaway keys.
Do not replace an everyday machine's `buzz://` handler without agreement.

1. Install and launch without a developer toolchain; respect Windows security
   policy for unsigned apps. Linux needs a working Secret Service desktop session.
2. Create/import identity, quit and relaunch with the same key. Check unavailable
   storage fails safely. Join the intended community, send/receive and reconnect.
3. Check cold/warm `buzz://` links, install a newer preview over the previous one,
   verify identity/settings survive, and record uninstall/retained-data behavior.
4. Have a human repeat install → messaging → restart before accepting the build.

Two Windows native failures were last observed at `a68b39d6` (legacy-import path
separator assertion and model-auth recovery). Re-run the existing manual Windows
CI lane on the candidate and diagnose any surviving failures separately from
installer success. The packaging jobs do not waive them or enable local-agent
hosting. Builderlab/NIP-FI admission remains a separate product limitation.
Windows/Linux installers published by normal release runs are in the preview
updater feed. Publishing or promoting a preview does not waive the manual
acceptance checks above, including an old→new automatic update on each platform.
