# Agent protection

Protection providers are installed, trusted plugins. They own checks, models,
policy UI and approval decisions. Buzz owns saved bindings, agent lifetimes,
native custody and the common dispatch gates. A missing provider, unsupported
runtime, failed check or cancelled check stops a protected action.

The provider API is version 3; the storage format below is version 4. This
experimental integration requires packaged macOS acceptance before production use.

## Local storage upgrade

Before the first protection save, native Buzz asks the owner to upgrade local
agent storage. **This is a one-way upgrade for every agent on the device.**
Older Buzz builds cannot list, run or remove any local agents afterward, even
if all protection bindings and defaults are subsequently cleared. Development
Buzz shares this store with the installed app. Close other Buzz builds before
confirming, and retain a compatible build. Identities and credential-store keys
are preserved; this does not move or export keys.

Cancel leaves identity and defaults files unchanged. Earlier protection previews
also require confirmation at startup. Cancelling that startup upgrade leaves
Agents unavailable in the new process; restart to retry. Never-protected stores
remain in the older compatible format until explicit confirmation.

Version 4 stores all membership rows and a monotonic `protectionClock` together.
Policy changes and newly committed identities after opt-in allocate from that
clock. Joins copy the identity's generation; defaults-only writes, deletion and
forgetting the final identity preserve the clock. Re-importing the same public
key cannot revive an earlier generation. Protected durable runtime state uses a
new namespace, so an older preview's ambiguous history is not resumed. Codex records the
protection `stateKey` with each saved thread and resumes it only under the same
key, so a policy change, or moving between unprotected and protected, starts a
new thread.

Codex records a turn's input before it is checked, so a refused input stays in
that thread and is checked again on each later turn there. If the protection
plugin saved the denial, each of those turns is refused at once. To continue,
start a new session in that conversation, or have the plugin forget its saved
denials (the security plugin's **Forget denied messages**, which clears them for
every agent) so the input is checked again. An input too large to check is
refused the same way, and forgetting does not help. Codex refuses it on each
later turn in that thread. Claude resumes its saved session and is refused
again. When that refusal comes before Claude reports its start, as it does in
the Claude versions checked, Buzz retries the turn in a new session, as starting
one yourself would. Either way, a new session recovers only once the oversized
text is no longer in what it is shown. Claude is shown the last 12 messages,
each cut to 4,000 characters, and any Canvas, so an oversized Canvas is refused
until it shrinks.

Protected Codex runs in Buzz's Codex home, like unprotected Codex. Its security
reviews run in a separate Buzz review home, which the security plugin keeps
read-only to contained workers. That home holds only links to the sign-in and to
the state Codex must write, and reviews turn off project instructions, skills and
memories, so no Codex settings, instructions, skills or memories reach a review.
The sign-in stays linked to the shared one, which contained workers can replace,
because Codex rotates refresh tokens and a copy would stop working. Signing in
through Buzz's Codex setup also records the ChatGPT workspace in the review
home, and reviews start Codex with `forced_chatgpt_workspace_id` set to it and
`forced_login_method="chatgpt"`. Codex then refuses an API key, or a sign-in
recorded for another workspace, before loading any workspace's managed
configuration. A replacement that records the pinned workspace with another
workspace's tokens is stopped only if OpenAI's servers check the two match,
which Buzz has not verified. Existing users must sign in through Buzz once,
which Codex's harness defaults offer while Codex is signed out: until then, and
while the shared sign-in is an API key or names another workspace, Codex reviews
fail closed with a message saying where to sign in. API key sign-ins, keyring
sign-in and custom model providers cannot run Codex reviews. Protected Codex
gives its tool shells an empty protection bridge address and token through
`shell_environment_policy.set`, which keeps the user's own shell policy. This
stops tool shells inheriting them, but a same-user command that reads the
engine's environment can still end the bridge session, and later turns then fail
closed. This follows Codex 0.164.0's source and is unverified against the
protected binary.

An earlier protection preview could save a version-2 identity envelope that
omitted memberships still present in its sidecar. Buzz refuses that incomplete
state without changing files or keys. There is no automatic repair: restore a
complete identities backup before retrying. This guard does not apply to a
complete ordinary version-2 multi-community store.

## Provider API

An installed plugin injects `agentProtection`, then registers
`{ processProtection, checkEvidence(metadata, source, signal), phases?(policy), runtimeProcesses? }`. Registration is owned by its
plugin ID; replacing or unloading it revokes the old registration and pending
checks. Only the exact boolean `true` permits an action. Exceptions, cancellation,
missing providers, invalid evidence or metadata, and the bounded deadline deny it.
A provider may instead deny with exactly `{allowed: false, reason}` to explain
the denial to people. Buzz reduces the reason to one line of at most 300
characters and uses it only when denying what a protected Codex agent reads (a
`context` check) ends its turn. The reason is the provider's text, often written
by a reviewer model that may quote or follow the denied input, so no agent
receives it: the denial returned to the agent stays generic, and the thread says
only that Codex could not finish. The reason shows as plain text with that
session's "Needs attention" status on the agent's Activity tab on this device;
it stays in memory and is never published to the relay.

`runtimeProcesses` maps runtime owner IDs, such as `buzz.codex`, to processes in
the protecting plugin's manifest. A bound `AgentProtection.spawn(options)` selects
only the captured agent's runtime and launches through that provider's captured
host scope. It always supplies the captured containment. Missing engines refuse
launch; provider replacement/unload kills its processes, including a launch that
finishes after revocation. Adapters keep ownership of sessions and credentials.
Native records the agent such a launch is for, after checking that agent's saved
protection names the provider, so the adapter can still bind that process's Buzz
credential to it, and to no other agent.

Manifest processes may declare `artifact: {path, sha256, siblings?}` instead of
`bundled`. Contained launches require one of these declarations; PATH-only
entrypoints are refused. Native launch hashes while copying the executable and
named siblings into a generation under the storage owner's shared Agents folder,
then executes that worker-read-only copy. Corrupt generations fail closed;
verification/copying runs off the async runtime. Symbolic links remain rejected.
These paths come from the installed plugin manifest, never from model input or PATH.
Host commands may also declare `artifact`; they are never contained, so each run
verifies the installed bytes in place instead of copying them.

`processProtection` contains `readOnlyPaths` and `hiddenPaths`, absolute or under
the user's home written `~/…`. Hidden paths must exist. A read-only path may lack
only its last component, under an existing parent other than `/`; workers cannot
then create, link or rename anything to that name.
The native process launcher adds agent controls, installed plugin storage and the
application bundle. macOS denies worker writes to these roots and replacement of
their ancestors, reads of private approval state, and Apple Events. Workspace
writes remain possible. Mutable development frontends and other operating
systems refuse protected processes. This is approval-authority containment, not
a general network/filesystem policy. Declared-file verification does not establish
integrity of every dependency an interpreter loads. Unsandboxed same-user processes,
including code planted for later execution, are outside this boundary; broader
isolation belongs to Sandpit. Protected Pi uses the app-bundled command helper
and the OS shell. Protected Claude reads through the same helper and runs its pinned
release as a declared artifact. Ordinary launch IDs and runtime PATH retain their
prior behavior.

Every provider implements `checkEvidence(metadata, source, signal)`. Metadata
contains `kind`, `session`, optional `command`, and host-captured `agent`, `relay`,
`runtime` and `policy`. The separate, pull-driven `TextSource` yields serialized
JSON content through `read()`. There is no total evidence byte limit; the provider
must consume the source completely before an allow is accepted. `kind` is
`context`, `tool` or `tool-result`. Session metadata is not authorization or proof
of the currently displayed conversation. Optional `phases(policy)` returns a
boolean for every action kind; it is captured from the native policy at launch.
Disabled phases still validate the provider lifetime, but send no inspection
evidence and do not invoke a checker. Omitting it enables every phase. Plugins
must propagate cancellation and must not derive identity/policy from tool text.

`snapshot()` returns native defaults/revision and current local agents with
binding/revision and runtime coverage. `saveDefaults(revision, policyOrNull)` and
`saveAgent(pubkey, revision, policyOrNull)` use native compare-and-swap. Another
provider's binding cannot be overwritten implicitly. Policies are JSON objects
limited to 32 KiB. Defaults are copied under the identity lock on every creation
and import path, including agent-requested creation.

Existing-agent saves require an idle runner and exclusive native hosting custody.
Every community membership, including disconnected ones, must acknowledge native
runtime retirement before persistence. A pubkey transition also holds memberships
that join while a save is pending. Failed retirement
continues to block retries. Native admission compares the cached protection
revision; stale app copies refuse work and refresh. Old handles are revoked. Protected identities use the confirmed version-4
envelope described above; incomplete protected version-2 sidecars are refused.

Installed plugins run in Buzz's trusted JavaScript context. Injecting this
service is not a separate permission grant or isolation boundary. Such plugins
can configure unbound identities/defaults and inspect policies. Completion with
`runtime: "agent"` selects a current agent's runtime/model configuration, then
calls that runtime provider's normal completion API; it does not grant an agent
handle or select a separate agent credential. Runtime providers retain credential
ownership. Install only plugins trusted with that authority.

## Action payloads and recovery

The common session gate checks cloned destinations and arguments. Built-in
file-backed `send`, `reply_in_subthread`, `mem_set`, `notes_set` and `canvas_set`
capture decoded text before review and execute that captured text. Protected
runtime readers declare a bundled `read-protected` process using the common
command helper's fixed system `base64` command. Delegated body and worker-selected
transcript reads inherit the captured native containment, including hidden
approval paths; they never fall back to an ordinary reader. Other plugins
exposing files to protected agents must provide that declared reader as well.
Protected attachment uploads are refused before reading or uploading files because the
current text review contract cannot fully inspect them. Ordinary attachment
uploads are unchanged. Oversized actions fail closed rather than omit content.

If a provider is missing, re-enable or reinstall the same plugin ID, then use
its settings to change or clear its agent policies and owner defaults. Missing
providers never silently remove protection. There is currently no host-owned
remove-protection control for a missing provider.

## Containment scope

Native containment protects Buzz's approval machinery while a worker runs. It
is not general workstation isolation or a guarantee against code that runs later
outside Buzz. Runtime and installed-plugin code remain trusted. Declared native
artifacts are verified and staged before launch; that does not verify an entire
runtime dependency graph or defend against other unsandboxed same-user programs.
Claude's protected agents and security reviews run its pinned release this way:
the host runs only its own verified copy, so a changed file in the download
folder never runs. Both ignore Claude settings files, though Claude still reads
its folder's cached managed settings. Security reviews also run in a Claude
folder of their own that Buzz Security hides from contained agents
(`~/Library/Application Support/Buzz/claude-code-review-home`), with the
Anthropic API key saved in **Settings → Agent setup → Harness defaults →
Claude → Edit configuration**, and no other credentials or API endpoint from
the environment. The key is not in a file: Buzz keeps it in the OS credential
store (Keychain on macOS, readable without a prompt only by Buzz itself), and
native code sets it as `ANTHROPIC_API_KEY` only in the Claude processes the
Claude plugin starts (`claude_key.rs`). Those processes pass it on to what
they start: commands a Claude agent runs, its hooks and its MCP servers can
read the key from their environment. Buzz does not set Claude's
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, which would also strip `SSH_AUTH_SOCK`,
`GIT_*` and every `*TOKEN` and `*KEY` variable. Keeping the key out of the
app's web view is the Claude plugin's own rule, not one native code enforces;
native code only refuses the key to other plugins and processes. Until a key is saved, and once
Anthropic rejects it, Claude reviews fail closed; save a working key or choose
another review model. A review's 60-second budget includes
waiting for Buzz to download that release the first time; a longer download
fails the review closed and carries on for later reviews.
Known Claude gaps: while a review runs, other processes of yours, likely
contained agents too (not checked against the pinned release), can read its
API key from the review's process environment, as every Claude agent has it in
its own. Protected Claude agents, unlike
reviews, still use `~/.claude`, which other contained agents can write, so one
can plant cached managed settings there that carry hooks and env into a
protected run's checks. Their transcripts live in `~/.claude/projects`
too, so a contained agent can swap one between a run's checks or before it
resumes.
Broader restrictions on workspace writes, startup files and login jobs belong to
Sandpit.

## Runtime contract

Runtime types declare `protection: true` only when every supported model request,
tool execution and tool result passes `AgentHandle.protection`. Their `retire(key)`
method (with the membership key, not its bare public key) must fully end existing native sessions before a policy changes. Missing
coverage refuses protected runs and session mutations, with the type's explicit
`protectionUnavailable` reason. Shared Buzz tool dispatch also gates exact input
snapshots and returned output/errors. It does not ask again about a call that a
runtime's native tool gate already reviewed with identical arguments; a captured
file body changes them, so that call is still reviewed.

Protected Pi uses one contained
worker per agent/provider generation and separate durable state per native policy
revision. Built-in providers, coding tools and Buzz tools are supported. User Pi
packages are not loaded into protected workers. The security plugin makes Buzz's Pi
packages folder (`~/Library/Application Support/Buzz/pi/deps`) and Pi's
`settings.json` read-only for contained workers. Pi's `auth.json` stays writable so
sign-ins can refresh; going by Pi's source, not checked live, a GitHub Copilot or
Azure sign-in stored there can set the address a Pi review calls. External Attention commands are
refused for protected agents until that path provides complete enforcement. Tool output/diagnostics/errors
remain buffered until approved, including safe replay. Model dispatch checks
cover restored history, compaction and retries. Deferred provider jobs and payload
rewrite callbacks are refused. Image-generation and classifier request shapes without explicit conversation messages are refused. An approved shell command is one action; its
internal syscalls are not separately reviewed.

The separate Buzz Security plugin owns the protected Codex/Goose source pins, patches, builds, release assets and
native boundary fixtures. Buzz packages only its ordinary Goose runtime; ordinary
Codex retains its independent updater. Installing the security plugin supplies
the protected engines on demand, without compiling them during Buzz development.

Protected Goose's native provider decorator gates model input,
including tool results, and its central tool dispatcher gates arguments together
with the native conversation, which Buzz exports from the worker hosting that
session. Providers with internal tool loops, command-line agent
providers such as `codex` and `cursor-agent`, toolshim, unreviewed native command
hooks, recipe shell callbacks and unsupported extension launches are refused.
A protected start is refused when the engine reports its gate in the wrong state:
on for review workers, off for agent sessions. Engines released before they
reported it are accepted. Protected agents have dedicated contained workers.
When an agent's provider is replaced, its next worker starts only after every
replaced worker has exited, and retiring the agent waits for them too.
Goose reviews read the owner's
Goose connection settings. The security plugin lists `config.yaml`, `secrets.yaml`,
`custom_providers` and `config.tmp`, which Goose saves `config.yaml` through, plus the
`.tmp` beside the target when `config.yaml` is a link, so they are read-only for
contained workers even before they exist. When the Goose folder (`~/.config/goose`,
or the one `GOOSE_PATH_ROOT` or `XDG_CONFIG_HOME` selects) is missing, the plugin
creates it with mode 0700 and creates nothing inside it (all in the companion plugin,
not here). Goose reviews refuse GitHub Copilot, whose sign-in cache sets its API
address, and the `codex` and `cursor-agent` command-line providers, which run their
own agents, whose settings contained workers may be able to change (inferred from
source, not checked live). A review without a provider uses Goose's
default, read in the review worker, and is refused when that is missing or refused.
Both Goose builds read the same Keychain item. The protected engine is a separate
binary, so macOS may ask for access; this is not checked live. Denied access leaves
Goose with `secrets.yaml`, which contained workers cannot change.

Protected Codex uses the plugin's separate pinned app server. Prepared HTTP/WebSocket model requests pass the
native gate, including recovery/compaction requests; native local tool dispatch
checks the arguments and conversation after hook rewrites. Hosted tools are
refused. The plugin ships its sibling `codex-code-mode-host` from the same patched
pin; both executable hashes must match before native launch.

Claude uses the pinned native CLI 2.1.305. Unfiltered input, pre-tool, raw success/
failure output and final tool-batch hooks await review. Native transcript plus
immutable native stream events provide preceding evidence while writes are
pending. A native watchdog kills stalled hook callbacks before the CLI's timeout
can fail open. Hook-registration errors and Stop terminate the worker. Workspace
instruction loading, attachments, native subagent delegation, background tasks,
experimental context clearing and fallback rewrites are disabled. Compaction and
session reset/fork are refused; protected resumes require the same native policy
state key and readable prior transcript. Start a new conversation when this
bounded path cannot continue. Do not describe this evidence as a lossless active
history snapshot.

Input inspection follows Goose's separation of conversation text from provider
configuration. Dynamic instructions and every native message are checked as
individual immutable sources before model dispatch; tool catalogues, schemas and
model options are not prompt-classifier evidence. Codex excludes only exact bundled
multi-agent mode text identified by its native fragment kind before attribution is
removed. Goose excludes only its exact compiled-in system prefix; custom prompts
and appended instructions, memory and external context remain inspection evidence.
Claude excludes only the known tool-catalogue fields in native prompt snapshots
and request-shape logs, plus top-level hook transport metadata. System text,
conversation payloads, unknown fields and nested data remain inspection evidence;
tool-action review retains the full hook input and preceding conversation.
Neither projection changes model-visible input or trusts a role label. Pi uses its native system-text
renderer to retain dynamic instruction sections without embedded tool declarations.
Codex validates local dispatch for additional tool declarations before excluding
those declarations from input inspection. Restored messages and tool results are
retained; this contract does not adopt Goose's ten-user-message window. An individual
source failure prevents model dispatch. Tool-action inspection still receives the
exact arguments and combined preceding native conversation.

Optional native plugin hooks are disabled for protected Pi, Claude and Codex workers until replacement payloads can be inspected in the correct order. Ordinary workers retain native hook dispatch.

All supported protected workers require packaged macOS containment. Reviewer
choice remains separate from the requesting runtime's enforcement capability.

## Configurable inspection models

Runtime plugins own `registerModels({label, models, complete})`; credentials remain
with that runtime. `modelChoices()` lists configured choices. A protection provider
calls `complete(model, {system, input, outputSchema?}, signal, requester?)` for
tool-free inference. The plugin owns instructions, schemas and response
parsing; the host returns text and the actual model. The `agent` model selector
resolves only the current requesting agent's configured runtime/model using its
host identity and relay. Runtime changes and cancellation reject the result.
Every registered runtime accepts `input` as either a string or a replayable `TextSource`. `writeJSON(process, value)` serializes these inputs through ordered, bounded process writes; `encodeJSON(value)` exposes the same encoding as an async iterator. A partial failed write stops the worker so the next request cannot be appended to an incomplete frame. The runtime/plugin owns model capacity and reports errors; the app imposes no total streaming prompt limit.

Runtime completion receives an optional fourth, prepared spawn function for the
calling protection plugin's engine. Codex and Goose require it for their isolated,
tool-free review workers; no global engine lookup or credential handoff is used.
Pi and Claude retain their existing runtime-owned tool-free transports. Each
runtime preserves system/input roles and disposes temporary inference work.

Buzz Security supplies the strict `{blocked, reason}` decision schema and its
separate detection, explanation and review prompts. Human explanations grant no
execution authority; model review creates no persistent agent identity.

Buzz Security independently configures incoming-content and dangerous-action
hooks, at default and per-agent scope. Each can be disabled or assigned a model
from any registered runtime, including custom model IDs. Recommended selections
are defaults rather than an allowlist. Model assessment is distinct from assigning
a Buzz agent to recommend or decide on a flagged action. The security plugin
offers model review by default, with an existing Buzz agent as an explicit option.

## Evidence

Focused tests cover native identity/default persistence, cross-copy custody,
stale admission, policy retirement, cancellation and shared Buzz tools. The macOS
protection CI job installs exact Pi lockfile dependencies and exercises real Pi
storage/tools with a synthetic model/checker: held/denied writes, withheld output,
cancellation, recovery, restored context and compaction. It also executes the
native macOS containment profile and verifies the pinned Claude download against
its release checksum. Claude additionally exercises withheld successful/failed
output and resumed transcripts. The plugin's native tests build exact protected
Goose/Codex pins and use synthetic loopback model responses with real filesystem
writes to prove held actions, denied writes and denied input. Relocating these
fixtures preserves their assertions and native coverage. These fixtures do not
establish packaged-app integration, real classifier health or real-model review
quality. Native build caches remain keyed by pins and patches. Human
acceptance and current UI/interaction checks remain required before marking the
experimental PR ready.

Protection plugins own evidence storage and model capacity. The shared `evidence/begin`, `chunk`, `finish`, and `cancel` protocol is bound to one worker and its host-owned policy. One chunk at a time is acknowledged after consumption; sequence and final byte count must match before approval. Codex and Goose share the native sender; Pi uses the same host channel over its process connection. Claude retains an immutable private transcript snapshot and pulls bounded sections. Small transcripts keep their per-record sources; larger ones stream as one source per phase, routed record by record, so phase policies apply the same at any size. The native Claude watchdog spools large frames and reads only control metadata. The security plugin stores large pending evidence separately and exposes bounded sections to human and model reviewers. Chunk, metadata, concurrency, and timeout bounds remain; none is a total evidence allowance. The ordinary command-output and HTTP-body ceilings remain 1 MiB and 4 MiB. Nothing is truncated to obtain an allow. The plugin's native classifier/model implementation can still materialize full evidence and is responsible for resource/model failures; this is not a constant-memory guarantee for every runtime. A failed inspection must pause or deny.
