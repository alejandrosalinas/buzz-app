# Deployment configuration: current-feature parity

Buzz Foundation supports configuration for capabilities that exist here, not a
port of every OG Buzz feature. Keep deployment overrides in local/CI configuration.
Build defaults are readable binary data, **never secret storage**.

## Supported inputs and surfaces

| Input | Consumer and boundary |
| --- | --- |
| `BUZZ_EXTERNAL_MCP_COMMUNITIES` | Frontend build: space-separated secure community origins allowed to authorize external MCP access. Empty disables access. See below. |
| `BUZZ_WORKFLOW_RESTRICTED_COMMUNITIES` | Frontend build: space-separated secure community origins where workflow messages cannot start or steer local agents. Empty keeps checked workflow delegation everywhere. See below. |
| `BUZZ_BUILDERLAB_URL` | Shared frontend/native build: the live development broker's Builderlab, and whether a build without an added sign-in server keeps the built-in one; no runtime override. See below. |
| `BUZZ_BUILDERLAB_APPS_DOMAIN` | Shared frontend/native build: exact Apps cookie domain paired with the login origin for native viewer SSO; no runtime override. |
| `BUZZ_BUILDERLAB_APPS_CONTROL_PLANE` | Shared frontend/native build: HTTPS origin of the Apps control plane for the configured login origin, for deployments the built-in public table does not list; no runtime override. |
| `BUZZ_BUILD_REPOSITORY_ACCESS` | Native build: default [repository access rules](repository-access.md#default-rules), in `repository-access.json`'s schema. Unset means none. |
| `BUZZ_DEFAULT_COMMUNITY_URL` | Packaged frontend build: secure relay origin to select once, after identity setup, only when this viewer has no saved community record. Saved choices, including Personal space, always win. Unset in OSS builds. |
| `BUZZ_BUILD_MANAGED_PLUGINS_URL` | Native build: `https` URL of a version 1 [managed plugin policy](managed-plugins.md#packaged-policy). The desktop app fetches it and keeps the last good copy, used when no `managed-plugins.json` exists. It only recommends. Unset in OSS builds. |
| `BUZZ_DATABRICKS_HOST` | Frontend build and dev server: `https://` Databricks workspace URL passed as `DATABRICKS_HOST` to every bundled `goose-acp`, which then prefers it to the host in goose's config. Unset in OSS builds. See [Databricks host](#databricks-host). |
| `BUZZ_MOBILE_APP_IOS_URL`, `BUZZ_MOBILE_APP_ANDROID_URL` | Frontend build: `https://` store listings for the build's mobile app, shown with QR codes on the mobile Settings card to people whose Builderlab account holds this device's backed-up key. Unset in OSS builds. See [Mobile app links](#mobile-app-links). |
| `BUZZ_RELAY_URL` | Live development broker's default community, not an agent relay override or a packaged default. |
| `BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY` | Presence-only alias for fresh-viewer community selection in live development only. Saved viewer choice wins. |
| `BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG` | Native and frontend build: sign-in servers added to the built-in one, each with its adapter prefix and community hosts; empty opts out. See below. |
| `BUZZ_DEV_OPEN_RELAY` | Development-specific override of that alias: only `1` enables; `0` explicitly opts out. Requires a relay URL and live viewer pin to have an effect. |
| `BUZZ_DEV_FIRST_RUN_ACCOUNT` | Dev server only: replaces first run's kgoose reads and writes (including the key link, the unlink and the saved-community add), its key backup and backup recovery. Builds define it empty. See [below](#first-run-account-seed-development). |
| `BUZZ_DEV_VIEWER`, `BUZZ_COMMUNITY_ALIASES`, `BUZZ_DEV_NOTIFICATIONS` | Existing public viewer pin, public routing aliases and dev notification override; unchanged. See the [development setup](contributing.md). |
| `BUZZ_UPDATER_PUBLIC_KEY`, `BUZZ_UPDATER_ENDPOINT` | Native release build, process environment only: two non-empty values register the updater plugin. The same public key and endpoint must reach `tauri build --config` as `plugins.updater`, and update archives must be signed by the matching private key. Desktop preview release runs supply both for every platform (see [releases](releases.md)); candidate-only and local builds report automatic updates as unavailable. |

The retired v1 inputs `BUZZ_BUILD_AGENT_ENV`, `BUZZ_BUILD_BUZZ_AGENT_PROVIDER`
and `BUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY` are no longer read or compiled. Agents
uses each plugin agent type's settings. Remove these old defaults from local/CI
configuration; they do not configure Agents. `BUZZ_OWNER_MCP_COMMUNITIES`,
which enabled the retired owner-read agent tools, is no longer read either.
Restart Vite to change broker or
routing configuration. Production frontend builds never load the dev broker or
expose its auto-open seed. They can separately opt into the packaged community
default below.

## External MCP community flag

`BUZZ_EXTERNAL_MCP_COMMUNITIES` is a space-separated list of `https://` or
`wss://` community origins. The default is empty, which disables external MCP
access in all communities. Invalid origins fail the build. The value is
compiled into the frontend; a launched app cannot change it through its environment.

The distributor's release build chooses the allowed communities; this
repository's workflow sets none. Community names do not grant access. The Agents service compares the exact canonical origin before
opening a connection and on each tool call. Consent disables other communities,
and Settings hides External apps there. Normal agent MCP servers are unchanged.

## Workflow restriction community flag

`BUZZ_WORKFLOW_RESTRICTED_COMMUNITIES` is a space-separated list of `https://`
or `wss://` community origins, parsed as the external flag is. The default is
empty: in every community, a workflow mention can start or steer a local Claude,
Codex, Goose or Pi agent when its creator is the agent's owner or a sibling the
owner attested. Each build lists its own restricted community origins. In a listed community no
workflow-marked message authorizes a local agent request, in bundled or plugin
harnesses; the message stays visible. While any community is listed, an agent
whose community cannot be read is restricted too. See
[workflows](workflows.md).

## Packaged community default

Internal packagers can set a public community origin for fresh installs:

```sh
BUZZ_DEFAULT_COMMUNITY_URL=wss://relay.example.com bin/pnpm tauri build
```

The frontend build reads this value from repository-root `.env.local` or the build
process environment (process wins, including an explicit empty value). It accepts
only `wss://` or `https://` origins without credentials, paths, queries or fragments;
invalid values fail the build. It is compiled into the frontend, so changing the
launched app's environment cannot override it. Leave it unset for OSS builds.
The dev server ignores it; live development retains its existing opt-in inputs.

After native identity restoration, creation or import, the existing community
service selects and saves this origin only if the viewer has no `buzz-client.v1`
record on this device. Any saved record wins, including Personal space, malformed
records and unresolvable aliases. A later build default cannot change that saved
choice. Selection starts the normal authenticated relay session; it grants no
membership or admission bypass. If the relay refuses admission or is offline,
the normal connection error/retry flow applies. No legacy preferences are copied.

## Databricks host

Internal packagers can point the bundled goose's Databricks provider at a
workspace:

```sh
BUZZ_DATABRICKS_HOST=https://workspace.cloud.databricks.com/ bin/pnpm tauri build
```

The frontend reads it from repository-root `.env.local` or the process
environment (process wins) and compiles it in. It must be an `https://` URL
without credentials; invalid values fail the build. Every `goose-acp` the goose
plugin starts receives it as `DATABRICKS_HOST`, so goose reports Databricks as
configured and ignores a host saved in goose's config. Only the host is set:
the model, thinking level and sign-in stay goose's own. Leave it unset for OSS
builds.

## Mobile app links

Packagers that publish a Buzz mobile app can link its store listings:

```sh
BUZZ_MOBILE_APP_IOS_URL=https://apps.example.com/ios \
BUZZ_MOBILE_APP_ANDROID_URL=https://apps.example.com/android bin/pnpm tauri build
```

The frontend reads each from repository-root `.env.local` or the process
environment (process wins) and compiles it in. Each must be an `https://` URL
without credentials; invalid values fail the build. When the Builderlab session
is signed in and this device's key is the account's linked, backed-up key (so
the phone restores it), the mobile Settings card says to install the app and
sign in with Builderlab, with a link and QR code for each listing that is set. With neither
set it gives the same instructions without links. Other identities keep the
pairing flow.

## Builderlab URL build input

Builderlab is the build's first sign-in server below: its identity origin with
`apiBasePath` less its `/api/goose/` suffix (another API base leaves Builderlab
unconfigured). Every Builderlab feature (hosted agents and communities, known
communities, Decisions, Apps, key backup) uses that server's one native
session, which is kept in the system keyring and survives a restart. To use
another deployment, add its sign-in server below, such as the
[staging descriptor](#builderlab-staging).

`BUZZ_BUILDERLAB_URL` is set in repository-root `.env.local` for development,
or in the process running `bin/pnpm build` / `bin/pnpm tauri build` for
packaging. Unset or set to `https://app.builderlab.xyz`, it keeps the built-in
server. Another origin, or an empty value, turns it off when nothing is added;
such a build has no Builderlab. Live development is the exception for another
origin: the Builderlab plugin still signs in to it through the development
broker, but the welcome screen never offers that sign-in. An empty value leaves
even that unconfigured. Alongside an added sign-in server, a
nonempty `BUZZ_BUILDERLAB_URL` fails the build.

## Federated identity build input

Every build trusts a compiled list of sign-in servers. A relay never chooses
one: each community is matched by its host against the list, and a community no
server covers connects without a token. Each server keeps its own native
session. The list starts with a built-in server, Builderlab for the public
hosted communities:

```json
{
  "version": 1,
  "id": "bb-public",
  "identityOrigin": "https://app.builderlab.xyz",
  "communityHosts": ["*.communities.buzz.xyz", "communities.buzz.xyz"],
  "adapterBase": "https://app.builderlab.xyz/api/goose",
  "apiBasePath": "/api/goose/"
}
```

With the built-in server, a build also trusts a server for each Builderlab
customer, named by the community's host: `buzz.{name}.builderlab.xyz` signs in
at `https://{name}.builderlab.xyz/api/goose`, on demand, with no organization
name. `{name}` is one DNS label. The server is added the first time one of its
communities connects, with its own session saved under its own fingerprint, and
listed (hosts only) so every later launch adds it again, even once none of its
communities remain: its session stays in Settings, and deleting an agent still
retires the agent's grant there. A full Buzz sign-out deletes the list. Its id
is `bb-{name}`, as Builderlab names its deployments, so its descriptor matches
one a build lists for the same deployment and a dev build finds the session
that build saved. For names of 61 to 63 bytes, which would exceed the 64-byte
id limit, it is the name's first 44 bytes and 16 hex digits of its SHA-256. A
listed server that covers the host, or has the same id, wins: a distributor's build keeps at-launch sign-in and its organization name
by listing its server. Builds without the built-in server have none of these.

`BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG` adds servers to it. Unset, the build
has the built-in server only. Empty, it has no sign-in servers. Otherwise it is
a public JSON descriptor, or a JSON list of them, placed before the built-in
server: the first server is the build's Builderlab. No two servers may share an
id or a community host. The value is supplied to Cargo through the build
environment, validated and compiled into native code, with no runtime override
or credential field. For `just desktop` and
`just desktop-bundle`, it can be set in `.env.local` (single-quote the JSON);
see [launch environment](#launch-environment).

The development broker turns FI off by itself: a `tauri dev` run with
`BUZZ_DEV_VIEWER` pinned and this input unset compiles no sign-in servers, so
developers don't set it empty for the broker. Packaged builds (`just
desktop-bundle`, debug or release) and the standalone plugin manager keep FI on
whatever the pin. A `tauri dev` run that adds servers keeps them. Tauri marks
the run (`DEP_TAURI_DEV`); Vite's dev server likewise leaves FI off and the
broker on.

```json
{
  "version": 1,
  "id": "example",
  "identityOrigin": "https://identity.example",
  "communityHosts": ["*.communities.example", "custom.example:8443"],
  "adapterBase": "https://identity.example/nip-fa/",
  "apiBasePath": "/api/goose/",
  "signIn": "at-launch",
  "organization": "Example"
}
```

### Builderlab staging

There is no built-in staging server. A build that signs in to Builderlab staging
adds it:

```sh
BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG='{"version":1,"id":"bb-public-staging","identityOrigin":"https://app.builderlabstaging.xyz","communityHosts":["*.communities.public.builderlabstaging.xyz","communities.public.builderlabstaging.xyz"],"adapterBase":"https://app.builderlabstaging.xyz/api/goose","apiBasePath":"/api/goose/"}'
```

Staging is then the build's Builderlab, with the built-in production server
after it for the public communities. A native test parses this exact
descriptor, so keep the two in step.

`signIn` and `organization` are optional. `signIn` is `on-demand` by default:
the app asks for organization sign-in only when a protected community refuses
the viewer, or from Settings → Identity. `at-launch` signs in before the app
opens and again whenever the session ends (see
[identity](identity.md#sign-in-at-launch)). `organization` is the display name
used in that sign-in copy, up to 64 characters. Neither is part of the deployment
fingerprint, so changing them keeps saved sessions. Each server's sessions are
stored under its own fingerprint, so adding servers keeps those saved before.

The first-run welcome screen's **Sign in with email** is this native
organization sign-in (see [identity](identity.md)).

Vite uses its existing environment loader; the native plugin-manager build reads
repository-root `.env.local` and process values using the native dotenv pattern.
For desktop, supply `BUZZ_BUILDERLAB_URL` in `.env.local` or the build process
environment so both stages receive it. Vite's additional `.env` and mode-specific
files do not configure native code. Process values take precedence, including an
explicit empty value. The desktop release workflow leaves it unset; see
[release configuration](releases.md#builderlab-url).

The bundled Builderlab plugin has no renderer network or file grant in any
build. In a build with a sign-in server, the plugin manager grants it only the
native forwarder's Builderlab routes for that server's session; Apps deploys go
through the same session to the control plane mapped from its identity origin
(`https://compose-ctrl.builderlab.xyz` for production). Another deployment sets
its control plane origin in `BUZZ_BUILDERLAB_APPS_CONTROL_PLANE`. The live
development broker serves the plugin itself. Never put credentials in these
inputs.

Identity backup uses the session only when its separately configured service URL
is the build's Builderlab, at the same origin and API base path. Backup still
requires its own service URL, namespace and user choice. The existing
identity-binding validator accepts production Builderlab or the configured origin.

Native viewer SSO also needs the exact Apps domain in
`BUZZ_BUILDERLAB_APPS_DOMAIN`, for example `apps.example.com` for a Builderlab
at `https://login.example.com`. Set it in the same local/build environment. Only
the public production Builderlab has a default Apps domain; other deployments
supply their mapping through build configuration. An explicit empty domain
disables native SSO. A missing mapping or an exchange endpoint returning 404
leaves the app's own website login in its account-isolated guest.
Authentication, permission, transport and other server errors do not fall back.

Restart desktop development after changing this input so Vite and the native
grant rebuild together; browser-only development needs a Vite restart. Production
web and desktop frontend builds substitute the value into compiled code: changing `.env.local`
or the launched app's environment afterward cannot override it. Rebuild and
redistribute to change a packaged value.

## First-run account seed (development)

After Builderlab sign-in, the first-launch flow reads four things about the
account from kgoose: the Nostr key bound to it, the communities it owns, the
destinations saved to it ([known communities](communities.md#known-communities))
and the keys it holds a backup of ([identity](identity.md)), binds a key it creates or
imports to an unlinked account, and, on Start over, unlinks the lost key
before binding the new one. A developer's real account is bound to their real key and that binding
must not change, so `BUZZ_DEV_FIRST_RUN_ACCOUNT` replaces those reads, the
binding, the unlink, the key backup and backup recovery — and nothing else —
on a dev server:

```sh
# A brand-new account: the key-setup choice follows sign-in.
BUZZ_DEV_FIRST_RUN_ACCOUNT=unlinked
# A returning user: Welcome back for this npub, with these owned communities.
BUZZ_DEV_FIRST_RUN_ACCOUNT='{"npub":"npub1…","communities":["design.example.com"]}'
# An account with these destinations saved to it (read with the account check).
BUZZ_DEV_FIRST_RUN_ACCOUNT='{"known":["chat.example.com","wss://buzz.example.org:8443"]}'
# A brand-new account whose every backup fails as if Builderlab were unreachable.
BUZZ_DEV_FIRST_RUN_ACCOUNT='{"backup":"unreachable"}'
# A brand-new account whose first backup fails, so Try again then succeeds.
BUZZ_DEV_FIRST_RUN_ACCOUNT='{"backup":"fail-once"}'
# A returning user whose Start over unlink fails as kgoose answering 503 would.
BUZZ_DEV_FIRST_RUN_ACCOUNT='{"npub":"npub1…","unlink":503}'
# A returning user with Restore from backup, which answers that recovery is unavailable.
BUZZ_DEV_FIRST_RUN_ACCOUNT='{"npub":"npub1…","backups":["npub1…"]}'
# The same, where every restore recovers this throwaway key.
BUZZ_DEV_FIRST_RUN_ACCOUNT='{"npub":"npub1…","backups":["npub1…"],"recovery":"nsec1…"}'
```

Every field is optional; without `npub` the account is unlinked. `communities`
lists hostnames (or `wss://`/`https://` origins) the way the Community URL field
accepts them; `known` lists the destinations saved to the account the same way,
answered as kgoose spells them (`wss://host[:port]`). `backup` names a failure kind from
`src/features/identity/backup-failure.ts` (such as `unreachable`, `timeout` or
`refused`), and every backup then fails with that kind's page; `fail-once`
fails only the first backup after each sign-in, as Builderlab not confirming
it, so Try again succeeds. `unlink` is an
HTTP error status (400–599), and every unlink then fails as kgoose answering it
would: a 429 or 5xx offers Try again, and a 401 reads as a lapsed sign-in. `backups` lists the npubs backup status answers
(none when absent), so Welcome back offers Restore from backup when it holds
`npub`. `recovery` is the `nsec1…` every restore recovers, which installing
imports as if it were typed; without it every restore answers that recovery is
unavailable, as every tenant does today. The value is plain text in your
environment, so use a throwaway key, never a real one. Vite exposes the value
as `VITE_BUZZ_FIRST_RUN_ACCOUNT` for `serve` only; `pnpm build` and
`pnpm tauri build` define it empty, so packaged apps always ask kgoose. A
malformed value fails the Vite configuration without being echoed. Restart the
dev server after changing it. With a seed, binding, unlinking and backup
succeed (unless `unlink` or `backup` is set), and a joined community's save to
the account succeeds, without a request, a native signature or a native backup
command, in every build.
Restore opens no browser and runs no native recovery command.

## Whole-video limit

The desktop app reads relay video from its origin one bounded `Range` at a
time. When an origin ignores it and answers a video with a whole `200`, the app
copies that video to a temporary file, up to the development broker's 500 MiB
video limit, and answers the player's requests from the file as bytes arrive.
The limit is the compile-time constant `WHOLE_VIDEO_MAX` in
`src-tauri/src/relay.rs`; edit it and rebuild to change it.

- A video of exactly the limit plays. A larger `Content-Length` is rejected with
  413 before any download; without one, the download stops and is rejected once
  it passes the limit. Without a `Content-Length`, playback starts once the
  whole video has arrived, since a range answer needs the total size.
- At most two such files exist at once, each anonymous and deleted by the OS
  when it closes. Opening a third drops the least recently used one. A file is
  kept while a player's connection to it is open or a read waits for its
  bytes, and for 60 seconds after; then it is dropped, stopping its download,
  and playing the video again downloads it again.

## Deliberate exclusions

Inputs that OG `block/buzz` at `99c2acf90cfbb1cb2d3a8bd900c0ec1642e20540`
(`desktop/src-tauri/build.rs` and its runtime consumers) or release builds read,
and this app does not.

| OG/release input | Why it is not implemented here |
| --- | --- |
| `BUZZ_DESKTOP_BUILD_RELAY_URL` | Retired name; internal builds use `BUZZ_DEFAULT_COMMUNITY_URL` above. No legacy input alias or admission bypass is added. Native macOS, Windows and Linux otherwise restore the selected saved community; new admission uses Join a community. Windows/Linux installed-app acceptance remains unverified. The dev broker and saved agent destinations remain separate. See [packaged identity](identity.md). |
| `BUZZ_BUILD_RELAY_RECONNECT_CMD` | No reconnect-command feature; arbitrary deployment command execution is not added. |
| Updater helper fallback aliases | Only the two canonical updater names above are read. Private signing keys never belong in app defaults. |
| `--features mesh-llm` | No mesh/provider integration is supplied by the native identity crate. Import carries identities, not legacy runtimes. |
| `BUZZ_BUILD_OBSERVER_ARCHIVE_DEFAULT`, `BUZZ_BUILD_AGENT_METRIC_ARCHIVE_DEFAULT` | Already no-ops in inspected OG: its archive capability checks return true for all builds. This app does not claim equivalent archive collection by accepting inert flags. |
| Build-command `BUZZ_ACP_ALLOWED_RESPOND_TO`, `BUZZ_ACP_ALLOWED_CHANNEL_ADD_POLICIES` | OG consumers are runtime-only; setting these around compilation does not bake them. The retired v1 listener no longer consumes these inputs; Agents uses its attention settings. |
| Mobile `BUZZ_AGE_GATING_ENABLED`, Android `BUZZ_ANDROID_RELEASE_SIGNING=external` | No corresponding Flutter/Android target in this app. |
| CI version/tag metadata, artifact paths/upload controls, signing teams/profiles, Apple/App Store/package-registry/Play credentials, Android signer roles/sockets, SDK/JDK/toolchain settings, Tauri bundle/config arguments | Release infrastructure and packaging controls, not product defaults. No new build-variable forwarding API. |

Ignored `.env.local` can contain unrelated development settings. Only the inputs
with current consumers listed above have an effect. Do not use any build input
for private keys, tokens or raw agent configuration.

## Launch environment

`just desktop` and `just desktop-bundle` add every `BUZZ_` value from
repository-root `.env.local` to the environment of Tauri, Cargo and the native
app. Values are read as the frontend's Builderlab URL reader reads them (Node
`parseEnv`): `$VAR` is never expanded, quoted or not, so a value needs no
escaping. Vite's `.env` and mode-specific files are not read for this. Because
the Vite dev server inherits this environment, a `.env.local` value also beats
the same name in a mode file for the frontend, so frontend and native agree. A
value already in the process environment wins, including an explicit empty
one. Names without the `BUZZ_` prefix stay out, because `.env.local` can hold
unrelated settings and credentials, and so do the release-only
`BUZZ_UPDATER_*` inputs. `BUZZ_` values reach child processes of the app, so keep them
to public configuration. Direct `pnpm tauri build` and `cargo` runs do not load
`.env.local` this way.
