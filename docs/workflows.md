# Workflows plugin

The bundled page owns the editor and drafts. The existing relay session owns
configuration reads and commands through its reader and durable outbox; the dev
broker or native host owns authentication and the fixed run-history route. The
relay executes workflows. No separate connection, cache, outbox, scheduler or backend changes.
See the [capability contract](../src/features/workflows/types.ts).

## Scope

- Channel-scoped saved configurations; new drafts start disabled.
- The landing groups compact workflow rows under prominent channel headings,
  sorted by channel name and filtered in place by channel. The filter lists only
  channels with loaded workflows and supports multiple selections. An empty
  channel selection shows all channels. Selection is not persisted across sessions.
  Separate Owner, Status, Trigger, and Channels dropdowns sit above the collection,
  with Clear all alongside the controls. A filtered empty result offers Clear
  filters and returns focus to Owner; an unfiltered setup state offers New workflow
  only when creation is available. Active dropdown triggers show the selected
  value and its icon, or a count with a generic icon when several values are
  selected. Each active trigger has a separate clear icon.
  Owner and Status use inline radios;
  Trigger and Channels use inline checkboxes. Popups have no Clear action.
  My workflows is the default and matches the current viewer's saved workflow
  ownership. All channel workflows includes other owners in participating channels;
  the Owner trigger names whichever option is selected. When only My workflows
  hides other owners' workflows, the empty state says so and offers All channel
  workflows.
  Rows and their details show the owner's current identity name, with an abbreviated
  public-key fallback while a profile is unavailable or nameless, including through
  the active naming policy. Fallbacks lengthen their suffix to stay distinct across
  visible owners. Visible owners hydrate together in background profile
  batches of up to 500 identities. Narrow rows reflow their artwork, text, and
  independent controls as text grows. Editing, enabling and running remain tied
  to the workflow author. A verified owner of an agent can also delete that
  agent's workflows, signing as themselves;
  select All channel workflows to find them. This ownership-authorized deletion
  also works with a Guest channel role. Ownership claims in display metadata
  do not grant permission, and the relay authorizes every deletion. Losing the
  verified ownership proof disables deletion in the app; it does not clear the
  relay's separately recorded agent owner.
  If permission changes during confirmation, an error explains why deletion
  could not start; the editor retains its draft.
  Clearing the owner filter or Clear all shows all channel workflows.
  Enabled and Disabled match saved configuration (omitted means enabled), not
  confirmed runtime activity; unreadable configurations are excluded from both.
  Trigger filters use the same saved-type interpretation as the workflow rows:
  Message, Reaction, Diff, Schedule, or Webhook. Unknown/unreadable trigger types
  remain visible when no trigger types are selected. Selected trigger types match
  any of those types; this result intersects with Owner, Status, and Channels.
  Selected channels include workflows from any of those channels.
  Trigger and channel choices use wide popups with scrollable two-column lists.
  Channel choices remain available regardless of the other filters.
  An icon-only sort menu stays at the far right of the filter row. By channel
  keeps the channel groups; Recently updated shows a flat list ordered by saved
  configuration timestamp, newest first, with channel names on each row. Equal
  timestamps use the workflow coordinate (channel, owner, UUID) as a stable tiebreak.
  Saving an edit, including toggling configured state, updates the saved timestamp;
  edits within the same second still follow that tiebreak.
  Sorting is local to the page and Clear all only resets filters. Switching sort
  recreates the row/detail views, resetting run-history paging and card-local state.
  Discovery still reads all eligible channels.
  Creating a workflow can still target any eligible channel. Each row runs the
  saved configuration in one click and toggles its configured state. Selecting
  a row shows its detail, actions and run history in a resizable side pane, as
  on Agents; a created run rereads that history. Editing opens a modal over the
  list. Create begins with channel selection in that editor; the empty draft's
  primary action adds its first step.
  Form mode uses a selectable flow and contextual inspector, with insertion
  menus and removal. On narrow screens the inspector is a nested side dialog.
  Escape closes a menu, then inspector, then editor with a dirty-draft warning.
  Trigger and step-action choices use labelled field selectors. With nothing
  selected, the inspector shows the workflow's name, description, channel and
  enabled state; draft errors stay visible while their field is hidden. Form,
  YAML and Runs tabs switch views; save recovery stays visible.
- Form editing for message/reaction/diff/schedule/webhook triggers and Send
  Message/Delay/Call Webhook actions. Basic conditions cover text, author,
  reaction and message-ID comparisons; unrepresentable expressions stay Advanced.
  Basic literal whitespace is preserved; expressions that cannot rebuild
  losslessly stay Advanced. Incomplete Basic rows block saving and lossy view
  switches until corrected or explicitly removed, and participate in leave/unload
  warnings even when their YAML is unchanged. Step conditions and timeouts live
  under Run controls.
  Webhook URLs may contain relay-expanded templates; headers and request bodies
  are configuration visible to channel members, not a secret store. The relay
  owns destination safety and channel-owner/admin authorization.
  Schedules offer repeat presets, weekday and
  day-of-month pickers, a UTC run time and a five-field cron editor. Numeric
  weekdays follow the relay: Sunday=1 through Saturday=7; existing numeric
  cron fields are not renumbered. Six- and
  seven-field cron stays in YAML. Other definitions stay in YAML; opening them
  does not rewrite their contents.
- Save with the original owner/channel/UUID and signed `expected-revision`.
  Warn before enabling an unfiltered message trigger or a schedule that runs
  hourly or more often, not on ordinary enabled edits.
- Webhook triggers: the relay issues a secret once, when a workflow first
  gains the trigger. The save receipt hands it to a one-time dialog with the
  hook URL, masked value, reveal and copy; leaving before revealing or copying
  asks for confirmation. Delivery stays mounted across channel/landing navigation;
  pending secrets are shown sequentially, and session clear/access loss purges
  any displayed value. The secret is held in memory until that dialog takes
  it and never enters the outbox journal, operation errors or logs. The hook
  URL needs the relay HTTP base the host advertises; without it the dialog
  shows the relative `/hooks/{id}` route only.
- Destructive deletion confirmation, unconfirmed manual run of the saved
  configuration (the editor's Run now is unavailable while the draft has
  unsaved changes), and on-demand run/trace history in
  20-row pages with the relay's exact `(before,beforeId)` cursor.
- Archived channels: the relay accepts saves and runs there, but every run
  fails. Their group and Recently updated rows say Archived. Run now and
  turning a workflow on are unavailable in rows, details and the editor, whose
  Save is blocked only while the draft is enabled; turning off and Delete stay
  available. New workflow omits them; the landing keeps them so an open editor
  keeps its draft.
- No approval UI, lifecycle negotiation, plugin command-replay API or JSON
  trigger inputs.

## Recovery and limits

The outbox journals intent/signature before publication. A verified echo does
not replace the result-bearing receipt. Restored commands never run automatically;
result text stays ephemeral, outside the journal. Workflow intents cannot be replayed
through generic Outbox Retry either; inspection and dismissal remain available.

**Check saved configuration** resolves an unknown save only when a fresh verified
head matches its owner, channel, UUID and exact signed revision. Missing/different
heads retain the draft for review. A verified head newer than the save releases
its lock on toggle, run and delete; the relay's expected-revision check still
rejects stale saves. Run requests do not leave configuration writes unresolved after
unknown delivery, but a pending request still locks conflicting actions until its
outcome is known. Dismissal clears the notice and editor lock
only after durable dismissal; it neither undoes nor repeats a command. Exact
readback does not retire a pending one-time-secret receipt, and a missing receipt
does not undo verified configuration success. Unknown
runs stay unknown: only a returned run ID identifies a requested run.

An empty successful deletion receipt is reconciled only by a fresh read started
after that receipt: the workflow's owner/channel/UUID must be absent from a
complete channel result. Landing deletion confirms on the list without mounting an
editor. Confirming deletion in detail discards the local draft and returns to the
list immediately, including on a synchronous submission error. The session/outbox
continues delivery; the landing remains mounted across channel/editor navigation
and owns readback and recovery. There is no deletion progress in the editor.

Pending rows remain visible with **Deleting…** and disabled actions. Confirmed
removal refreshes the landing without resubmitting deletion. Rejection restores
row actions. Submission errors, rejection, and unconfirmed outcomes use the
existing toast stack; uncertain results offer **Check saved configuration**, which
also resumes a paused read. Missing receipts, partial/failed reads, and retained
legacy definitions never establish removal. Explicit **Dismiss notice** confirms
that dismissal does not confirm, cancel, or repeat deletion; actions stay locked
until durable dismissal succeeds, and persistence errors remain recoverable.
Session clear/access loss purges copied data and recovery UI. Work already running
may continue. The compact **Refresh workflows** icon keeps the old app's label and
rereads definitions for the known channels; it does not rediscover project channels.

Saving a configured enabled flag does not prove runtime activation or cancellation.
Legacy deletion can retain a visible definition; accepted delivery is not proof
of runtime cleanup. These backend limitations are displayed, not repaired here.

The landing discovers workflows in serial batches of up to 128 participating
channel IDs, including authorized DMs. Each request uses one kind-30620 filter
whose `#h` contains the whole batch, reading all authors in 100-event pages.
Full pages continue with the relay's exact `until`/`before_id` cursor, preserving
same-timestamp definitions. Each batch finishes paging before the next starts
with a fresh cursor; retry and refresh also start at the head. Signed event IDs
are deduplicated before counting/folding, and non-advancing pages fail the read.
The existing reader/broker request and response byte budgets and per-request
deadlines apply to every page. 500 memberships need four initial requests plus
continuations for full pages. Single-channel detail reads remain capped at 100
events and mark saturated results partial. Completed landing batch reads are
retained in the session workflow capability: returning within ten seconds can
reuse the matching batch without another relay read, and older retained results
can warm the landing while a fresh read runs. Retaining a completed batch evicts
older retained batches that requested any of the same channels, including empty
results, so targeted save readback cannot leave an overlapping stale landing
batch reusable. Explicit Refresh, save readback, configuration commands,
receipts, disconnects, access loss, cache clear and session disposal bypass or
purge that reuse. Retention is memory-only and bounded; a finished scan is not
proof of an exhaustive runtime inventory.

Metadata renames/reordering do not restart discovery; new memberships add only
their missing reads. One stable status replaces
per-channel loading placeholders, and loaded rows remain visible during refresh.
Refresh deliberately rereads the current roster; save outcomes request readback
only for their affected channels. Verified editor readback also refreshes that
channel on the landing, including when the receipt arrived before the saved
head became visible. Read failures/interruption stop the queued scan
and expose one paused status and Retry without erasing already loaded configurations
or inventing errors for unread channels. Retry resumes only failed/interrupted and
unread channels; membership additions join that paused queue, not restart it.
The header Refresh still deliberately rereads the full roster. Global clear
purges copied results without automatic rereads; a changed membership set
re-establishes authorized interest. At most two capability views remain live,
including one invalidation observer when discovery is idle.

Reads begin on UI interest and stop on unmount or access loss; no background poll.
Transient socket recovery cancels stale reads but retains the draft. Live-session
commands use the shared socket's result-bearing OK receipt; disconnect after send
leaves the outcome unknown and never automatically replays the command. The dev
broker requires a live owner and matched frontend/host versions. The packaged
native host publishes through its signed HTTP transport and serves
workflow history through a fixed authenticated GET; relay-authorized workflow
events share the existing outbox. Refresh checks current data.
Actual access loss purges private snapshots before callbacks. Drafts are editor-local,
not durable, and never move between viewers or communities. The broker preserves
same-origin checks, signature validation, captured principal quotas, cancellation,
fixed upstream paths and bounded history/receipt bodies.

## Validation boundary

Offline regressions cover the editor, exact-save recovery, uncertain commands,
session isolation, broker authorization and history. The real-session browser
journeys cover navigating to the landing, exact readback both before and after
the receipt, masked secret delivery, and automatic landing-row refresh in
Chromium and WebKit. Component tests
cover sequential secrets, interruption, and purge after the dialog takes a value.
This is not live acceptance:
create → edit → run → inspect against an unchanged backend and packaged-native
acceptance remain unverified. Live credentials, native launch and real workflow
writes require separate consent; no backend work belongs to this plugin PR.

## Message attribution

Relay-attested workflow messages show an automation icon and **Workflow · owned
by …**, not a message authored by the owner. The full message byline links the
owner profile. Its information icon opens a short card, on pointer rest or click,
explaining that the owner set up the workflow but did not send the message
personally; it shows no keys. Compact Search, Inbox/activity, link previews and
notification titles retain the automation label; opening the message shows the
full byline. Notifications use cached names only and do not add profile reads.

Attribution requires a verified kind-9 event from the selected community's
explicit NIP-11 `self`, exactly one canonical `buzz:workflow=true` marker and one
canonical lowercase-hex `buzz:workflow-owner` tag. Admission-owned immutable
records carry reusable verification evidence; unsigned local intent, copied
caller proof symbols and ordinary senders cannot establish it. No signature
verification runs while folding retained history.

The owner tag identifies the identity that scheduled the workflow, not the author
of every rendered word. Templates can include trigger-controlled values; those
values do not acquire the owner's prompt authority.

Claude Code, Codex, Pi and Goose also use this proof to authorize delegated
workflow mentions. Agent types that plugins bring do not.
The receiving agent's ready community session must supply the explicit relay
authority. The workflow owner must be that agent's owner, or an agent whose
admitted kind-0 profile cryptographically proves the same owner through NIP-OA.
The profile comes from the receiving agent's community profile directory;
display metadata and saved inventories do not prove sibling ownership. Missing,
invalid or failed profile reads deny the mention; a later mention can retry.
Both runtimes recheck delivery cancellation after authorization, before creating
sessions or starting processes, so removing an agent during a profile read cannot
restart it when the read completes.
The event must contain a canonical `buzz:workflow-mention` for the receiving
agent; all such tags
must have exactly two fields, a lowercase-hex pubkey, and no duplicate targets.
The relay emits these tags only for targets present in the owner-authored template
and the rendered output. Legacy `p` tags route mentions but do not authorize them.
Workflows created and maintained under an owned agent's own key remain owned by
that agent and can wake agents with the same proven human owner. This does not
grant an agent permission to edit a workflow owned by a different signing identity.

Builds can withhold this delegation per community. In communities listed by
`BUZZ_WORKFLOW_RESTRICTED_COMMUNITIES`, no message carrying a `buzz:workflow` tag
authorizes a local agent request, whatever its signer, owner or mention tags, in
bundled or plugin harnesses. Workflow messages there stay visible but do not start
or steer local Claude, Codex, Goose or Pi agents, including for owner-created
static templates and scheduled workflows. Each build lists its own restricted
communities; communities it does not list keep the delegation above. The restriction
does not prevent workflow output from influencing a later authorized turn. See
[configuration](configuration.md#workflow-restriction-community-flag).

Cached-only startup intentionally shows the actual signer until a live connection
establishes explicit relay authority. Saved operator-contact `relayAuthor` is not
promoted to `self`, and no new trusted storage is introduced. Signer-based search
and Inbox sender filters and relay-reported participant
summaries are unchanged by workflow presentation. Channel/thread rows retain the
effective-author attribution and owner edit/delete behavior added separately in
#661; when that author differs from the signer, the row keeps the signing key
for row identity only and does not display it. Thread and media views
request workflow-owner profiles through the existing background profile directory.
The workflow proof controls the automation label and the delegated-mention gate
above; it does not control main's effective message-author policy. With explicit
authority, an unadmitted copy has neither a workflow label nor delegated prompt
authority, but can still receive main's effective-author attribution; production reads
must retain their admission-owned event objects. Without explicit authority,
cached-only startup keeps the signer fallback described above.
Participant summaries have no per-message owner evidence
and continue to identify signing participants, not workflow owners. Workflow rows
are not grouped together because the message metadata lacks a workflow/run ID.
Exact workflow/run navigation and historical execution configuration are not claimed.
