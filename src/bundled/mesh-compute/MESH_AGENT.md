# Agents “Mesh” type

Agents → New agent → **Mesh** uses this community’s shared compute, with no
alternate provider. Agent mode runs on the Goose plugin’s bundled `goose-acp`.

## Source ownership

The plugin registers the Mesh agent type through the shared Agents extension point.
Agent mode runs on the app's bundled `goose-acp` through the Goose plugin's
`GooseProcess` and Buzz tool servers; `meshGoose.ts` points it at the mesh route.
Chat mode, native identity/community admission and the Mesh node live in
`compute/` (including its Tauri commands), compiled into every build.
`src-tauri/src/mesh_compute.rs` only lends it the signed-in identity
(Mesh-status signing) and the authenticated relay client.

## Modes and admission

- **Chat:** one leased chat completion, no local or Buzz tools. Normal host
  delivery applies, without a sibling-watch exception.
- **Agent (default):** goose runs with its `developer` extension limited to
  `shell`, plus `skills`, in the configured workspace (default `~/.buzz`). Local
  tools have the user’s filesystem authority, not a sandbox. No other goose
  extensions load; the user’s own goose config is not used.
- **Buzz tools:** Agent mode always offers the full shared Buzz catalog
  with `buzz_` names: send, edit-message, react, read, channels, members,
  users, dm, mem_get, mem_set, canvas and media_get. Calls use the
  existing TypeScript handlers and captured agent handle/native signer. No key
  enters the model. Agent mode includes core-memory guidance; Chat remains tool-free.
  The retired `buzz` config flag is ignored.

Both modes remain owner-only. Watches and non-owner mentions do not grant
permission to trigger Mesh. No mode triggers itself. In both modes, matched
Interest instructions apply only to the owner's watched turn; the watched message
is data rather than a direct request. Later direct mentions do not inherit those
instructions.

## Quick setup

Settings → Shared compute → Helpers creates Thread summarizer, Translator,
Media converter or Custom agent through the existing Agents creation service.
Chat presets have no tools; Agent presets disclose local shell/files and Buzz
access before creation. Defaults are created directly; edit names, instructions,
mode and workspace afterward in Agents → Settings. Configure Attention and add
the agent to a conversation there. Emoji maker and the shared emoji-publishing
operation are removed; existing agent identities and published emoji are not deleted.

## Conversations and delivery

A DM is one conversation. Otherwise **Thread** scope separates thread roots
(and new top-level mentions), while **Channel** scope orders the whole channel.
Follow-ups queue behind the current turn; they do not steer an active run.
The host runs one mention turn per agent at a time, including across conversations;
queued mentions receive their execution deadline when dispatched, not while waiting.
Separate agents remain independent.

Every turn reads recent Buzz conversation history as the agent: the thread root
and replies, or the latest channel messages for a whole-channel conversation.
Results are deduplicated, sorted oldest-first and bounded to 50 earlier messages.
History-read failure leaves the latest request available. Agent turns with Buzz
access also read fresh core memory. When enabled, `buzz_read` can retrieve exact
older messages with a small limit, explicit channel and pagination/search.

Final prose is automatically posted as the agent’s reply, independently of any
optional tool sends. A send neither ends the turn nor suppresses that final post;
the send schema omits `final`. No final text produces a visible failure rather
than substituting tool narration. DMs have no thread tags; channel responses
reference the triggering message and retain its thread root.

Cancellation is passed to the goose session. Disposal cancels
in-flight work and prevents queued deliveries from starting. Cancelled, retired or
stale-lease results are not posted. Already-published sends and completed local
tool effects are not rolled back or automatically replayed.

## History and host boundary

The transcript view shows up to 50 in-memory runs, including partial tool
evidence. Reload/quit discards them. Chat has no tool transcript.

The plugin manifest declares the bundled `goose` (`goose-acp`) process and
`files` (native `~` workspace resolution, no `pwd`, so it works on Windows). Agent inference/tool
sequencing runs in goose; Buzz tools are the Goose plugin’s tool servers. Native identity, lease and cancellation checks are independent of
frontend delivery checks. This is the existing trusted-main-WebView model, not a
hostile-plugin security boundary.

## Validation boundary

`meshAgent.test.ts` exercises delivery policy, Chat and Agent watches, conversation
history, queued follow-ups, final posting and cancellation using a stub adapter.
`meshGoose.test.ts` covers the goose session setup and mesh route. Rust tests in
`compute/` cover the node lifecycle, sharing, publication and inference gateway.
These are not packaged GUI/live Mesh/real-relay acceptance.
