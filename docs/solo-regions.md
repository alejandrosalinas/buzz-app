# Solo regions

The host exposes `ctx.soloNavigation.version === 2` only with the complete region
implementation. The public types are exported from `@buzz/author`. The service is
created with the relay in `src/app/services.ts`; plugins register sources through
their tracked Cordis context.

The host derives `buzz.region:<pluginId>:<sourceId>` from the caller. A ready
catalog that explicitly disables a plugin shows its eligible labeled chats in
the ordinary Solo inventory while retaining their labels and filing guards.
Their region associations stay dormant and are reclaimed if the plugin is
enabled again. A missing source alone does not imply that a plugin is disabled:
loading, unavailable, failed, not-installed, and unknown states remain in the
recovery placement. The host uses one projection for region presentation,
inventory exclusion, and personal filing guards. Unknown channel types do not
imply Solo. Existing personal workspace assignments remain stored while those
assignments are dormant. Label edits preserve region labels. There is no public
remove operation.

Each bind has a fresh incarnation. Reconnect and Retry abort the previous bind;
old handles, menus, state writes, and reveal subscribers cannot act in the new
incarnation. A source must return increasing revisions with the current binding.
Header actions remain outside the component error boundary, so a source can offer
recovery actions while the host renders its channels.

A ready snapshot with `hidden: true` keeps the region out of the sidebar: the
host draws no heading, rows, header actions, or "In" chip for it, and it neither
names the Solo tab nor composes its workspaces. The region stays in the shared
projection, so its labeled chats stay out of the Solo list, its filing guard and
workspace still apply, and its drafts still start; the chats remain reachable by
links, notifications, and search, and the source presents them in its own UI. If the
plugin is explicitly disabled, its chats appear in ordinary Solo instead. Other
non-ready states (off, loading, unavailable, failed) show the recovery region,
so the chats remain reachable when the source cannot present them.

The source owns its content, presentation, and disclosure controls. It receives
the stable `ui.Conversation` component. Conversation renders only live channels
and calls its children with the name, preview, selected state, and bound parts:
`Link` supplies navigation, current state, focus identity, and rename; `Menu`
supplies the standard chat menu; `Actions` is its overflow button; `Reveal`
shows content only at rest or only while the menu is active; and `Unread` shows
the host unread state. `ui.Card` is the shared
`NavigationCard`, which owns hover, selection, and drag-target paint. Typography,
status, and layout inside a row are the source's choice. Source styles may target
`.navigation-item`, `.navigation-item-trailing`, `.buzz-button-label`,
`[data-navigation-card]` with its `.navigation-card-row`, `-body`, and `-footer`
parts, `[data-solo-disclosure]`, `[data-channel-activity]`, and
`[data-channel-unread]`. They may read `--session-action-size`,
`--session-trailing-end`, `--project-icon-size`, and `--channel-row-fill-start`
and `-end` for row geometry. Other host classes and module class names are
private. Conversations are not drag sources and cannot file into personal
workspaces.

A source can open a channel that also appears in Team with
`ctx.navigation.open(target, { sidebar: "preserve" })`. This opening keeps the
sidebar scope, scroll, and disclosure state. It does not select or reveal the
Team row. The source supplies its own selected row. Check
`ctx.navigation.snapshot().attempt.sidebar` along with the target to select it
only for this opening. Retry retains the option. Later opens and Back/Forward
use the normal destination rules. The option does not change access or focus.

`data-solo-destination-id` is a supported behavior hook. A primary
`Conversation.Link` carries its channel ID; secondary links omit the marker.
Recovery destinations use the same marker. Nexus uses it to identify dragged
tasks and restore focus after a move. Plugins must scope queries to their own
region. Changes to the marker or its meaning require coordinated updates to the
host and consuming plugins.

The host retains one JSON state value per scope, viewer, and source key across
unmount, disposal, and registration. It accepts at most 16 KiB. A failed or stale
write returns false and does not update the memory value. Sources must keep their
own accepted state unchanged when a write fails.

`handle.state(binding)` returns `get()`, `set(value)`, and
`subscribe(listener)` for this same record. It works before the component mounts.
The component's `state` has the same methods. `get()` returns `undefined` when
the record is absent and preserves JSON `null`. It throws when the binding ends,
the saved JSON is invalid, or storage is unavailable without an accepted memory
value. `set()` returns false for a stale binding, an invalid value, an oversized
value, or a failed storage write. Writes replace the whole record; the last write
wins. This is device state, with no relay read or write.

Subscribers receive local writes and matching storage events from other windows.
The listener reads the current value with `get()`; it receives no initial call.
Unrelated keys do not notify it. The returned function ends the subscription.
Binding abort and source disposal also remove it. `state(binding)` and
`subscribe()` throw for an ended binding. Source disposal preserves saved bytes.
Plugins must require a host release with `handle.state` before they use this API.

`openDraft` opens the host's New chat editor for the region, optionally in a
workspace, with its own draft, files, model, and effort. Send works like an
ordinary New chat: the create goes out unguarded with the region label before
the first message, so the Outbox retries both after a restart. A source's
`draftAgent` narrows the agents the draft may address. Send is refused while the
source is not running and ready. Before the create, the host saves on this
device how the chat started; `started` returns it to that region's source until
`forget`. Sources reconcile their own records from it by channel ID.

Check `handle.draftContext === true` before passing
`draft: { context: JsonValue, key?: string }` to `openDraft`. The host retains
and returns this JSON through `started`; only the source interprets it. It uses
the same create, first-message, Outbox and reconciliation flow as any region
draft. There is no source callback before creation.

Without a key, context uses the existing region/workspace draft. A key gives
the source a separate text, attachment, settings, model and effort slot. It
stays the same when the user changes workspace. Keys are 1–128 characters from
`A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, and `-`, starting with a letter or digit.
Use a stable key for the same intent, and different keys for different drafts.
Context travels in navigation history, including reload, so keep secrets out.
The navigation parser copies JSON and limits the complete target to 8 KiB.
Missing or invalid required context must be handled by the source. A failed
start returns the prompt and files to the same draft slot as before.

The host does not interpret source-owned roles or select their workspace rows.
Sources use `draft.context` for their own meaning and `Workspace.selected` for
selection. For a region route or saved start with no explicit `draft`, the host
returns an unkeyed `draft.context` containing `{ saved: <original source> }`.
It retains that source unchanged through workspace changes, Send, reload, and
retry. A route source contains its original `kind`, `region`, and optional
`project`; a start source contains `region` and optional `workspace`. The plugin
interprets any other saved fields. Explicit `draft` metadata takes precedence;
invalid metadata fails instead of falling back. Existing workspace draft slots
stay in place.

Host reveal listeners receive live intent only. A pending request is kept only
for a late source subscriber and ends when navigation leaves or the connection
changes. The header chip can explicitly reveal the same current chat after a
manual scroll through the scroll owner's `revealAgain`; ordinary retries never
re-arm viewport ownership. Missing plugins use generic recovery copy, and catalog
loading does not imply that a plugin is uninstalled.

Reveal requests expand the host frame and let the source open the path. After
commit, the host uses the existing sidebar reveal retry. Recovery rows use the
same destination marker. Removing a focused row restores focus to a remaining row,
then the region heading; removing the region restores focus to the Solo heading.

Focused tests live beside `solo-navigation.ts` and `SoloRegions.tsx`. Browser and
native app checks must still cover geometry, both themes, enlarged text, keyboard
focus, hidden sections, and relay signing. DOM checks do not establish those facts.

## Personal workspaces

`ctx.soloNavigation.workspaces` exposes the bound user's Solo workspace catalog.
Pass the current region binding to `snapshot`, `subscribe`, `refresh`, and
`create({id, name})`. The snapshot contains IDs, names, status, creation
availability, and any read error. Ordinary chat assignments remain host-owned.
Refresh before retrying uncertain creation and keep the same ID and name.
Ended bindings cannot read or write a new community. The existing Solo writer
enforces authorization, record capacity, and revision checks.

Regions own their task filing; they do not add an ordinary Solo assignment for
each task. Workspace selection in a task draft is personal metadata and is
never part of the signed message.
