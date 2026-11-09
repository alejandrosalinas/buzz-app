# Builderlab

One Builderlab account for communities and agents that Builderlab hosts for you, so they keep working even when Buzz is closed.

## Getting started

1. Go to **Settings → Plugins → Builderlab** and choose **Sign in with Builderlab**.
2. To host a community, choose **Create community** under **Communities**. Buzz opens the join for the new community at once; publish your profile there and it opens and appears in the community picker. **Copy address** shares the address with others.
3. To host an agent, in **Agents** choose **New agent** and pick **Builderlab** under **Remote** in the **Harness** menu. It can answer while your desktop is off, but cannot open files on your computer.
4. If signed out, choose the small **Sign in** button beside Harness. Model, Thinking and Create agent stay disabled until sign-in completes. Choose a model and thinking level, optionally add instructions, then choose **Create agent**. Review the introduction and choose **Let’s go** to create it.
5. Edit model settings and instructions later in **Identity**. Opening it attempts sign-in automatically if needed. The compact action beside Harness shows a spinner that cancels browser sign-in on click. The resting signed-out hint explains that sign-in enables editing while messaging still works. Cancellation, timeout and login failures wait for an explicit inline retry. Sheets are reserved for settings or account-access errors. Instructions appear after sign-in. Native account-access errors open **Identity → Organization sign-in** without ending the shared session. In live development, **Use another account** ends the broker session and opens `/logout` in your browser. A cancellable spinner then waits three seconds before showing **Retry** beside Harness. Sign in with the other account in the browser, return to Buzz, then click Retry to check broker access.

While signed in, Identity shows a cloud beside “Remote agent”, with “Runs on a
Builderlab machine” underneath. Workspace in Settings explains that the remote
runtime is shared with your other agents in the workspace by default, alongside
availability and file access. These hints stay hidden while signed out or signing in.
Current remote activity steps show a cloud that pulses while working and stays
still with reduced motion.
Cards and pane headings omit location captions. Both @ menus show
Remote for known remote agents, alongside membership details.
Local agents get no location caption. The Harness menu groups types under
Remote and Local; local agents have no execution hint.
Activity shows its transcript and feed guidance without a separate workspace
note. Only the creation introduction speaks in the agent’s voice.

---

# Builderlab

## Apps pilot

Local agents can create, deploy, inspect readiness, share and open Apps Platform
apps using the Builderlab sign-in, the native NIP-FI session: native sends it to
the control plane, so the renderer never holds it. `apps_contract` reports the selected
tenant's runtimes and schema location. Creation checks that contract and supports
`static` and `fetch-js`; it repeats the selected runtime through reservation and
initialization. The executable profile returns the required asset manifest and
bindings, even when its handler serves all content itself.

Sharing follows the one-workspace model: `apps_visibility` switches an app
between everyone in the owner's workspace and only the owner, and
`apps_community` grants or revokes a Buzz community at the grant revision it just
read. `apps_visibility` keeps existing viewers and community grants.

Every tenant uses the same authenticated control-plane boundary: the server must
grant Builderlab access to the current workspace/account. These tools do not
enable a workspace or bypass its policy. A denied request preserves the server's
permission error. Check the contract before choosing a profile because a tenant
need not support static hosting.

After an accepted deployment, readiness errors preserve its app, version,
deployment and rollout IDs. `apps_status` checks those exact IDs without uploading
again. A failed reservation or initialization names the planned app ID; inspect or
resume that app before creating another one. Automatic reservation recovery and
hosted tool declarations are separate work.

The macOS app panel uses the same sign-in for viewing. Native code exchanges the
NIP-FI session on the identity origin's API (in live development, the broker's
sign-in on the broker) for a restricted viewer credential and absolute expiry,
then installs the HttpOnly/Secure viewer cookie before opening the original app
URL. The guest never receives the session token. App authorization and consent
still run at ingress.
Opening a different tenant's app never forwards the current account's credential.

Each account has its own website storage, kept across sign-ins and restarts, so
an app's own website login persists while native exchange is unavailable. Signing
out or changing accounts closes live and retained guests. Canceling sign-in or
disposing the plugin closes its local guests without ending the native session.
Other platforms do not expose the app panel. Apps that require pre-app consent
still use the existing canonical browser authentication gate.

## Remote agents

The bundled `block.builderlab` plugin adds Settings → Plugins → Builderlab: one
sign-in, the native NIP-FI session (or in live development the broker's), then
hosted communities (`communities/`, see
[plugin architecture](../../../docs/plugin-architecture.md)) and remote agents.
With a configured Builderlab, it also registers
`block.builderlab/builderlab` in Agents' new-agent type picker.
`adapter-type/` connects this hosted type to Beekeeper: provision registers the
agent, activation submits the owner proof and community supplied by Agents, and
removal deletes the provider runtime. Agents owns unfinished setup recovery and
the runtime-tagged community registration; the provider keeps the key and runs
the agent even while Buzz is closed. On desktop, creation has a small Sign in
action beside Harness. Create agent stays disabled until sign-in completes;
Model and Thinking remain visible but disabled while signed out. The action
starts the shared native sign-in and shows a clickable loading spinner that
cancels browser sign-in, matching the agent pane. Account verification keeps
the spinner without cancellation. Login errors stay in the form; failed or
cancelled sign-in preserves the draft for retry. Confirmed deletion still
starts sign-in when needed and continues after it succeeds. Both flows share
an existing sign-in attempt. Deletion's wait has no cancellation control;
disabling the plugin or closing Buzz also cancels it. Sign-out lives in
Identity → Organization sign-in, because community sign-in shares the session.
Beekeeper accepts an owner proof only from the Buzz key bound to the signed-in
Builderlab account. After sign-in, and again before each activation, the plugin
checks `/v1/buzz/nostr-identities/current` and binds an unbound account to this
device's key through the native kind 24243 signer, which accepts only
production Builderlab or this build's Builderlab origin. An account
bound to another key is reported and never unbound.
The agent's Identity tab reads its current instructions from Builderlab and
saves changes directly to the provider. Loading and saving use the same login;
failed saves keep the draft, and switching accounts requires the original
account before saving. A different signed-in account locks the fields and shows
that requirement instead of the previous account's errors and retries. Signed-out
panes hide stale settings errors and retries while retaining the draft.
Empty instructions can be saved to clear them.
Signed-out agent panes offer the same compact Sign in action as creation, beside
Harness in Identity. Model and Thinking remain visible and disabled. Instructions
are absent while signed out and animate in after sign-in, respecting reduced
motion. The draft survives sign-out and returning to its original account.
Message, Memory and Activity use the Buzz community connection independently of
Builderlab sign-in. Opening Identity attempts sign-in once if needed. Click the
compact spinner beside Harness to cancel browser sign-in; its tooltip and
accessible name are “Cancel sign-in”. Cancellation and failures leave an explicit
Sign in action instead of starting another attempt. Account recovery and
settings failures retain the host-owned notice surface. Native account recovery
opens Identity → Organization sign-in without ending the shared session. In live
development, Use another account signs out the broker before opening browser
logout. If an agent is missing
from the current list, Retry reloads it without signing out. Slow settings/catalog
reads offer a scoped retry after three seconds.
The Identity tab also loads a separate model catalog from Builderlab. Choose a
model and one of that model's thinking levels, then save the pair for new tasks.
There is no default or fallback selection. Missing or unavailable saved choices
show the server's setup status and require a supported pair. Changing the model
clears the effort choice. One shared Save action sits in the agent pane's bottom
footer and saves the Identity draft. When model settings and instructions both
change, they are sent in one update. While signed in to the original account,
Instructions alone remain editable when the model catalog is unavailable;
a changed model requires a supported effort before
the draft can be saved.
The model control uses the same family submenus as Goose. Builderlab's catalog
aliases are mapped to families in `adapter-type/models.ts`; update that mapping
with Builderlab's catalog information until its API supplies family metadata.
The server still owns available choices, names and thinking levels. Unmapped
aliases use shared family inference from the model ID and name; unrecognized
models remain selectable under Other. Families without a shared brand mark use
the generic model icon.
Creation offers the same catalog choices and optional instructions. The provider
registers and activates the agent before saving the settings together. Unfinished
setup retains these values on this device so retry continues the same agent,
including after a restart. Setup completes only once the settings save succeeds.
Settings shows the fixed remote workspace and per-thread session behavior, with
a link to the configured Builderlab site for remote runtime management.
Activity shows the turns the agent published to its owner while Buzz has been
open. Opened from a conversation, it shows that conversation's turns, and
**Show all conversations** widens it to every conversation; each new request
for the conversation's transcript narrows it again. Hosted frames name a thread
only for per-thread sessions, so a turn without one counts as its channel's
conversation, the per-channel session every thread there shares. It needs
the Agent Activity plugin, which owns the feed.
Create sends the chosen picture with registration, and Beekeeper publishes it at
attestation. Renaming or changing the picture republishes the agent's profile
through Beekeeper's `update-agent-profile`.
While the hosted type is registered, the plugin also provides `ctx.builderlab`
so bundled consumers such as Bestie can set a hosted agent's model and
instructions with the same login. It offers only sign-in, the signed-in
account subject, list, the model catalog and those two updates; it never
exposes the session token or the Beekeeper client.

The adapter retains the provider agent ID, server, verified account subject and
provisioning replay reference in `buzz.builderlab.adapter-identity.v1:` records.
No credentials or owner proofs are saved. These records survive restart and
deletion so retries can confirm an already-missing runtime without assuming
absence from another account's list. Registration retains its replay UUID until
Agents has saved unfinished setup and begins activation, or provider deletion
is confirmed. On another device, removal resolves the ID from the signed-in
account's list; an unknown key is refused. Existing Settings-created
agents are not migrated into this type.

- `session.ts` is the `BuilderlabSession` consumers share. It projects the
  native NIP-FI session: native holds the token in OS secure storage, so
  sign-in survives restart, and adds it as `Authorization: Bearer` to this
  plugin's granted routes. Each session revision reads its account from
  `/v1/auth/me`. A 401 refuses only that call; native then asks the adapter's
  `GET /v1/session` once and ends the session only if the adapter refuses it.
  Its sign-out lives in Identity → Organization sign-in, which `login/` links to,
  because community sign-in shares the session. In live development it projects
  the development broker's sign-in instead, through `brokerApi`.
- `capabilities.ts` keeps a sign-in's permissions at most a minute old, on
  demand: reading the session's snapshot starts a due re-read in the background,
  and acting waits for it through `freshCredential`. Gates read the flags and
  never refresh by hand. Concurrent reads join one request; failed attempts keep
  cached values and wait a minute before another attempt. There is no timer, but
  a surface that keeps reading the session, such as Attention readiness, re-reads
  `/v1/auth/me` about once a minute while it does.
- `oauth/` names the build's Builderlab API (`oauthTarget`). `oauth/first-run.ts`
  lets the app's first-launch welcome screen run the same native NIP-FI
  sign-in before the plugin's JavaScript starts; the app's later calls go
  through the forwarder as this plugin's bundled installation
  (`bundledFederatedIdentity`). That grant exists only while this plugin is
  enabled, so with it turned off that sign-in refuses before opening the
  browser.
  A successful first-run sign-in continues into the app-owned setup steps
  described in [identity](../../../docs/identity.md): the app reads the key
  bound to the account, the destinations saved to it (this plugin's
  known-communities list route, never through the Settings session's client)
  and the communities it owns through this plugin's bundled grant
  (`src/features/identity/builderlab-account.ts`, reusing the
  `communities/` routes and parsers); a linked account is asked for that
  key, otherwise the user creates a key or brings one they already have, and
  that key is then bound to the account through the same native signer and
  backed up (an imported key only once the user agrees);
  starting over creates a new key and unlinks the lost one before binding it.
  Key backup hands the sign-in to the native uploader, and the same portal is
  asked which keys the account holds a backup of; Welcome back
  restores the linked key from one through native recovery's own browser
  sign-in.
- `login/` owns the login experience: pending state, cancellation, retry, email
  display, and sign-out.
- `agents/` lists the signed-in account's remote agents beneath login, with
  refresh and retry. Settings directs people to the **Agents** tab to create,
  edit instructions and delete agents. Listing does not activate agents or
  publish community registrations. Requests go through `session.request`;
  sign-out and navigation discard late results.
  The client also supplies the hosted adapter's Beekeeper operations. Pending
  registration UUIDs survive restart, scoped to server, verified account and
  name. Retry the same name after an uncertain failure within the server's
  seven-day replay window. Instructions are limited to 20,000 characters,
  affect newly accepted tasks and are never published to the relay.
- `known-communities/` keeps the account's community list in step with this
  device through the `knownCommunities` capability while signed in, in native
  builds with a configured service. The list is an account-scoped set behind
  three idempotent JSON routes under `/v1/buzz/known-communities/`: `list`
  (`{}` → `{ communities: [{ community_url }] }`), `add` and `remove` (each
  `{ community_url }`; adding a saved destination or removing an absent one
  succeeds, and adds past about 1,000 saved destinations are refused with
  `limit_reached`). Each sign-in merges the complete list (adding what it
  lists; a saved membership it omits is kept and not uploaded again, since
  removals made on another device are ignored for now), then sends each
  destination's latest queued join or leave one at a time, retrying failures
  as sent. A list this client cannot read halts sync until the next sign-in,
  as does a 404 on any route (not yet deployed); a listed address the device
  could never save is dropped and counted, never a halt. See
  [communities](../../../docs/communities.md#known-communities).

The plugin's server is the build's Builderlab: its first
[sign-in server](../../../docs/configuration.md#federated-identity-build-input),
the built-in `https://app.builderlab.xyz` unless the build adds another, whose
native session it uses and which survives a restart. Its only network access is
the native forwarder's grant for that session: no renderer network or file
access. Live development signs in through the development broker instead. A
build with neither has no Builderlab: the plugin registers nothing.

The login snapshot retains `capabilities.can_use_remote_agents`; only explicit
`true` enables remote agents. Otherwise, Harness defaults and Builderlab Settings
show “Unavailable for this account”; the provider dialog explains the same
restriction. The Harness defaults row has no action. Account management stays in
Settings → Builderlab, and no Beekeeper requests are sent. Permissions are
re-read from `/v1/auth/me` once they are a minute old and the session is read
again; failed reads retain the previous values. Only capabilities change;
account identity and display details remain those read at sign-in.

The plugin also offers Builderlab as a Decisions API provider while the user is
signed in. It reads `capabilities.can_use_builderlab_decisions` the same way:
only explicit `true` makes it ready, and otherwise it needs setup, its settings
say it is unavailable for this account, and no decision request goes to it.
Without a choice, the first default that can answer does, so TypeSafe answers
until access is granted; when no default can, TypeSafe is shown, since its key
is something the user can add. While stale permissions refuse, Builderlab's
status is `checking` during the re-read that reading it starts. That never
moves the selection: a request is held for it only when no other default can
answer, and then, like Attention readiness, it waits within its deadline, so
a new grant is used by the request that noticed it. Live development retains refreshed flags and their cache age
across page reloads.
The plugin names the NIP-FI session by its revision, and
native `decide` posts to the identity origin's API with that
session as `Authorization: Bearer`, as for the build's other Builderlab calls;
the token never reaches the webview. A 401 there refuses only that call, and
native asks the adapter once whether the session still stands.
