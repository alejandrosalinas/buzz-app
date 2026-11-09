# OS deep links

Packaged desktop builds register a URL scheme with the operating system, so a
link opened outside the app brings it to the front and navigates, at cold start
too. Every build uses `buzz://`, the same scheme in-app links and **Copy link**
use. Ordinary `just desktop` development runs do not register the scheme or
enforce a single native instance, so linked worktrees can run in parallel. macOS
requires the registered bundle itself to run, not `just desktop` or another copy
with the same app identifier. Packaged builds share this scheme (see
[current limits](#current-limits)). Each packaged or debug-bundle launch makes
that app the scheme's handler, ahead of other apps declaring `buzz`, such as the
original Buzz desktop app; until its first launch, the OS chooses. The browser
build has no OS ingress and keeps
its `#buzz=` address form.

## Accepted links

The OS ingress accepts the Buzz link forms, plus two OS-only links described
after this list:

- `buzz://mcp-authorize?version=1&client=<name>&callback=<loopback-url>&state=<state>&scope=<scopes>&code_challenge=<challenge>&code_challenge_method=S256`
- `buzz://message?channel=<id>&id=<event>[&thread=<root>]`
- `buzz://plugin-install?repository=<encoded-https-or-ssh-url>[&ref=<encoded-branch-or-tag>][&path=<encoded-folder>][&commit=<40-or-64-hex>]`
- `buzz://plugin-install?id=<plugin-id>&url=<encoded-https-artifact-url>&sha256=<64-hex>`
- `buzz://channel/<id>`
- `buzz://channel/<id>/<event>` (the original desktop message alias)
- `buzz://repo?owner=<64-hex key>&d=<identifier>[&tab=<section>]`
- `buzz://pr?id=<64-hex event>&owner=<64-hex key>&d=<repository>`
- `buzz://issue?id=<64-hex event>&owner=<64-hex key>&d=<repository>`
- `buzz://join?relay=<wss-url>&code=<code>[&policy_receipt=<receipt>]`
- `buzz://connect?relay=<wss-url>`
- `buzz://add-community?relay=<wss-url>[&name=<name>]`
- `buzz://plugin?id=<plugin id>[&page=<page id>][&route.<key>=<value>...]`
- `buzz://agent/new?card=<id>`
- `buzz://settings[?section=<section>][&provider=<agent type>]`, such as `buzz://settings?section=agents&provider=buzz.claude-code%2Fclaude-code`, which opens Claude's setup in Agent setup. `provider` needs `section=agents`. Like the Settings target it becomes, it only presents Settings and has no community scope.

Two more links work only at the OS boundary. Neither names a destination, and
neither is a Buzz link form, so messages and Notes show them as plain text.
Bare `buzz://` (also `buzz:///`), the Builderlab console's **Open Buzz app**,
brings Buzz to the front and opens nothing, at cold start too. It shows no
notice, any query or fragment is ignored, and it never replaces a link still
waiting to open, whether that link arrived with it or earlier.
`buzz://sign-in`, the account pages' **Open Buzz**, asks first run to sign in
again (`identity/sign-in-requests.ts`). Unlike bare `buzz://`, it wins like any
other latest link: when links arrive together and it is the last, it is the one
acted on and the others do not open.

External authorization links show owner consent. They never grant access on arrival. The [external app protocol](agents.md#external-app-authorization) defines the callback, S256 exchange, scopes, and expiry. Handshake values stay outside navigation history.

Plugin install links open **Settings > Plugins > Manage plugins** and fetch a
preview from the Git repository and optional branch or tag. The repository accepts
HTTPS, `ssh://`, `git@host:path`, `github.com/owner/repo`, or `owner/repo`.
Percent-encode each query value. `path` selects the plugin folder inside the
repository (relative, `/`-separated; no `..`, backslashes or absolute paths). `commit`
pins the install to that exact commit: nothing installs unless the fetched repository
matches it. Repeating any of the four keys makes the link invalid. Review the plugin
and computer access, then select **Install plugin**. Opening the link does not install, enable, or grant access.
You can close a linked preview while Git loads; its late result is discarded.
An omitted `ref` uses the repository default. Duplicate known parameters and
repository credentials are rejected.

The Settings target has no community scope. A new installation completes identity
setup before the app can show it. Repositories hosted by a Buzz community require
that community to be selected and connected for authentication. See
[Git imports and SSH agents](plugin-architecture.md#open-a-git-import-from-a-link).

Query-based invite, message and plugin links also accept a single `/` before `?`,
as supplied by Windows URL activation (for example, `buzz://join/?relay=…&code=…`).
Non-root paths remain unsupported for these forms; channel paths are unchanged.

Agent card links open **Agents** with **Create agent** filled in from a
published Builderlab agent card, as Buzz mobile does. `card` is 1-64 ASCII
letters, digits, `_` or `-`. The app reads `<id>/agent.json` from this build's
avatars CDN (staging for a `https://app.builderlabstaging.xyz` build, production
otherwise), never from a host the link names: `id` must match, `name` and an
HTTPS `avatarUrl` are required, and `instructions` is optional. The card's
`model` is not applied. Instructions are filled in for harnesses that keep
them. Opening the link creates nothing; Close retires it. A card that can't be
loaded says why and offers **Try again**. Like the other navigation forms, it
binds to the selected community and viewer.

Plugin page links open a page contributed by an installed, enabled plugin. `id` and
`page` use the same 1-128 character lowercase token as plugin and page IDs (letters
`a-z`, digits, `.`, `_`, `-`, not starting with a symbol). Without `page`, the link
opens the plugin's primary page, or its first page when it has none. Each
`route.<key>=<value>` parameter (up to 16; keys of 1-64 ASCII letters, digits, `_` or
`-`; values up to 1,024 characters) becomes a string in the page's route params. The
page's own `route.validate` decides whether they apply: when the page declares no
route, or validation fails or throws, the page opens without params, never with
partial ones. A repeated `id`, `page` or `route.<key>` is ambiguous and rejected like
any other duplicate. A plugin that is not installed or enabled, or that has no such
page, fails with the ordinary "This page isn’t available" notice; installing or
enabling the plugin and choosing **Try again** reopens the same link. The plugin is
resolved only once the plugin runtime has settled, so a cold-start link waits for
activation rather than failing early. Like the entity links, the form binds to the
selected community and viewer, and a link is not authorization for anything the
page itself guards.

Entity sections are `files`, `commits`, `issues`, `prs`, `contributors`, and
`channels`; omitting the section opens the overview. Repository commit links add
`&tab=commits&commit=<40- or 64-hex hash>`. Identifiers use 1-64 ASCII letters,
digits, `_`, `-`, or `.`, without a leading dot or `..`. Query parameters outside
a form's grammar are ignored, with their values and any repeats, so a link that
another client decorated still opens; a duplicated known parameter is rejected as
ambiguous. The `channel` forms carry everything in the path and ignore any query.
The same forms work in message content.

The navigation forms above do not carry a community, so each binds to the currently
selected community and viewer, and fails `unavailable` when no community is
selected or no identity is known. `buzz://join` is the separate invitation form.
It holds through identity setup and opens the
existing join dialog with the relay and code prefilled; it never claims or saves
membership until the user completes discovery, policy acceptance, claim and profile
confirmation. The first-run welcome screen hands an address (and invite code)
typed there to the same intent when it enters the app on a restored community
instead ([identity](identity.md)), so one dialog serves both. The relay's HTTPS `/invite/<code>` page supplies that `buzz://join`
link; HTTPS itself is not registered as an OS handler. `buzz://connect`
(the relay website's **Open in Buzz**) and `buzz://add-community` (hosted
community **Open in Buzz**; `name` is ignored) are the same form without a code:
they open the join dialog with the relay prefilled or, when this device already
belongs to that community, switch to it. Apart from the two OS-only links
above, links that name no destination, such as unknown hosts, missing or
malformed parameters, malformed join
or community links, incomplete entity or plugin links and oversize links, show a "This
link doesn't work" notice. In a running app the notice shows over the current
page, and history is unchanged. A link that launches the app, read before the
client is first ready, opens Inbox in the selected community with the notice;
with Inbox turned off, the notice shows over the start page. A repeat replaces
the notice, and the next link that names a destination clears it. Without an
identity, selected community and settled plugin catalog a launch link waits
for them, and new navigation cancels it. A malformed link that replaces a valid
one still waiting for Retry also retires that Retry and its failure. A valid link that cannot open yet, or that is
not yours, keeps its own failure: `unavailable` with Retry, or `denied`.
Nothing is auto-joined. A valid address
is never authorization:
bound targets pass the same viewer, membership and channel checks as in-app
navigation, so a link into a channel you cannot read still fails `denied`. The
frontend expects the canonical lowercase `buzz:` scheme; the native URL parser
can normalize scheme case before delivery, so uppercase OS input is not
guaranteed to be rejected.

The latest arriving link wins, a malformed one included. Bare `buzz://` is the
exception: it names no destination and never replaces another link.
`buzz://sign-in` wins only among links that arrive with it. Before readiness,
one pending intent is retained;
if identity or community is missing, select a community and use **Retry navigation**.
The first known viewer and community bind the intent: switching either afterward
cannot reinterpret it. New navigation cancels it. A cold start opens the ordinary
start page before the destination.

Repositories owns entity presentation through the link-only `buzz.repos/repos`
page; it has no header destination or directory. Repository overviews, files,
commit history and selected diffs, issue/PR details and discussion, contributors,
and linked channels are read-only destinations. Old `buzz://project` links open
“Project containers are no longer available” with guidance to use a repository,
issue or pull request link. They do not read retired container metadata.
The composer’s ResourcePicker discovers listed repositories bound to the current
channel and searches their issues and pull requests directly.
Signed entity metadata remains visible independently of linked-channel access;
Git reads still enforce the relay's authorization. Missing entities and failed
explicit Git sections report navigation failure, not an empty successful page.

**Copy link** emits `buzz://message`, including a reply's thread root when known.
This deliberately omits the sender's community and identity: recipients must select
the correct community before opening it. Original mobile Buzz requires a UUID
channel identifier; named development channels are supported here but do not imply
mobile compatibility. The app has no link form of its own beyond the Buzz ones
and the two OS-only links, which message content also keeps as plain text. Any
other unknown `buzz://` host is rejected everywhere, staying plain text in
message content and showing the notice at the OS boundary.

## Testing locally

For OS ingress, use a packaged app or debug bundle. Write a link by hand, such as
`buzz://channel/general` or `buzz://message?channel=general&id=<64-hex event id>`.
A warm packaged app should come to the front and open the conversation. A cold
start should launch, show the start page, then open the destination once the
client is ready. A malformed link such as `buzz://unknown` or
`buzz://join?relay=example` must show the "This link doesn't work" notice over
the current page when warm, and open Inbox with it on a cold start. Ordinary `just desktop` keeps in-app Buzz links and
**Copy link**, but external `buzz://` delivery is not a supported development
contract.

For entity destinations, use `just web` with the existing authenticated development
broker, select the owning community, and open a Buzz repo, PR or issue link in a
message. No publication is needed to browse. The broker requires Git on its PATH;
it signs repository-root NIP-98 reads with the existing host identity. A selected
commit must show that exact revision and its diff. Back/Forward and Copy link
preserve the entity route, including the requested tab and commit.

**Before native testing:** coordinate with anyone using another Buzz copy on the
machine. Packaged/debug registration can change the installed app's handler, and
packaged apps with the shared app identifier permit only one active native
instance across checkouts. Use a disposable machine/profile or explicitly agree
which app owns the handler and how to restore it. If an older development launch
already claimed `buzz://`, launch the intended packaged app/debug bundle once, or
reinstall it, so that app claims the handler again. Do not launch/register a test
bundle over an active installation without agreement.

**macOS** only routes a scheme to a bundled app. `just desktop` binaries are never
registered, so build a debug bundle and launch it once to register it with Launch
Services and make its identifier the explicit `buzz` default. First quit every
other native Buzz copy, including `just desktop`.
For warm delivery, the bundle selected by Launch Services must itself be running;
forwarding an OS URL from that bundle to a different running copy is not supported:

```sh
just desktop-bundle --launch
open "buzz://channel/general"
```

Quit the app and run the last command again to test a cold start. The bundle lands
under the workspace `target/` directory because `src-tauri` is a workspace member.

**Windows** packaged/debug builds register the launching binary under the current
user on every start. Ordinary `just desktop` does not register. `just desktop`
and `just desktop-bundle --no-bundle` share `target/debug`; if you ran
`just desktop` after the last debug build, rebuild before launching the executable
or the registered binary will still have development-mode behavior. Use the
installed app or build and run a debug binary, then open a link:

```powershell
just desktop-bundle --no-bundle
.\target\debug\Buzz.exe
start buzz://channel/general
```

The NSIS installer registers the installed app as well; whichever build launched
most recently owns the scheme. Installing or updating the original Buzz desktop
app takes it back until this app launches again.

**Linux** packaged/debug builds write a `<binary>-handler.desktop` entry and call
`xdg-mime` and `update-desktop-database` on every start, so both must be
installed. Ordinary `just desktop` does not register. As on Windows, rerun
`just desktop-bundle --no-bundle` after any `just desktop` launch before testing
the shared `target/debug` executable. Packaged `.deb` and AppImage builds also
declare the scheme in their desktop entry.

```sh
just desktop-bundle --no-bundle
./target/debug/Buzz
xdg-open "buzz://channel/general"
```

## Current limits

- Ordinary development runs do not register `buzz` or enforce the packaged
  single-instance policy. Several worktree apps can run together, but external
  `buzz://` links have no guaranteed development target.
- Every local package keeps the same application identifier, so packaged/debug
  apps share app data and single-instance identity. This is one active packaged
  native Buzz per machine, not per-worktree isolation; Launch Services can list
  several bundles under that identity. On macOS, a registered bundle launched
  while a different copy (including an unbundled dev process) is running can exit
  before receiving the OS URL. The running copy may gain focus without opening
  the link. Cross-copy URL handoff is unsupported: quit the other copy and open
  the link with the intended registered bundle. Cold-start acceptance requires no
  native copy running; warm acceptance requires that exact registered bundle
  already running. Windows/Linux use the plugin's argv handoff.
- Ordinary development worktrees still share app data.
- Invite links (`buzz://join`) open the explicit join dialog; HTTPS
  `/invite/<code>` URLs are shareable through the relay landing page but are not
  registered as OS application links. Remote push is not handled.
- Git browsing uses the authenticated development broker or, in desktop builds,
  native NIP-98 signed reads through the system `git` on `PATH` (macOS also checks
  Homebrew paths). Without `git`, or on other adapters, entity metadata still shows
  and explicit Git sections report unavailable. PR commit lookups only read the base repository;
  external fork clone URLs are never fetched, so exact fork PR diffs are unavailable.
  No repository editing, issue changes, PR review
  decisions, or merge operations are included.
- Git reads fetch a fresh shallow repository per demand: latest 100 commits,
  20,000 file entries, 1 MiB text files and a 4 MiB response ceiling. The 12-second
  deadline and two-read concurrency bound work, not downloaded pack bytes/disk.
  Very large repositories may fail. Empty repositories show no files/commits;
  requesting a specific absent revision still fails. Discovery and issue/PR lists show at most 100 events;
  activity exceeding the 500-event safety bound reports unavailable. These are
  finite views, not exhaustive analytics. Project member resolution is bounded to
  64 members. Valid metadata identifiers outside Buzz's link grammar remain visible
  but cannot be opened/shared through these routes.
- Only the main window receives links. Release signing and distribution remain
  unconfigured; a locally built bundle is enough to exercise scheme registration.
