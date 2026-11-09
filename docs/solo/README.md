# Solo

Solo starts as a private channel whose only human member is its owner, talking with
their agents. Its owner can invite members or open it for community viewing.
It is not a separate page, message store or relay-enforced privacy
mode: a Solo chat is a channel, opened in Messages like any other. Ordinary
channel visibility and signed membership determine access.

## Model

- **The `buzz.solo` channel label is the one Solo fact.** It is a NIP-CL label
  on the channel's relay metadata, so every member and agent, including
  remote agents without the owner's encrypted state, reads the same answer.
  Discovery derives `channelType: "solo"` from it alone. A Solo channel gets
  the chat treatment for everyone: a timeline that loads history on scroll and
  top-level agent replies. It reads, caches and threads like any channel. The creator (the relay-written `P`) also gets the
  owner's treatment: the default-agent composer, Share, Chat
  settings and Chat actions. Both come from the channel, in the shared
  conversation scope (`features/conversation/Conversation.tsx`), so every view
  of a chat (the main reader or a secondary tab) composes under the same rules.
  Other channels are threaded. Conversion to a channel clears the label.
- **The label decides the sidebar.** Every Solo chat the viewer is a member of
  lists under Solo: their own and any shared with them, whether added directly or
  through an explicit membership grant. A shared chat starts in Chats and the
  viewer may file it in one of their own workspaces; it never lists under Team.
  Ordinary channels list under Team. Opening a chat without membership adds
  nothing to the sidebar.
- **Tags follow company.** Alone with agents, a send must tag one. Once another
  person is a member, people can talk without a tag; agents still answer only
  when tagged. The composer reads "Message your agents" alone and "Message this
  conversation" once shared. The sidebar's All / Solo / Team filter lists Solo workspaces and chats above
  Team's channel sections; it never changes the open conversation. Opening a
  destination reveals its inventory unless the filter is All; an unlisted
  conversation waits for the channel list rather than guess. Solo is always on.
- **Workspaces are the only private state.** The encrypted `groups:me` preference
  record holds Solo workspaces and which chat is filed in which workspace. It never
  decides what is Solo.
- **Drafts are a Messages route.** A new Solo chat is
  `{ kind: "solo-draft", project?, agent? }` on the Messages page; nothing exists
  on the relay until the first send. The retired `buzz.me/me`,
  `buzz.sessions/sessions` and channel `new-session` routes no longer exist.
- **Workspaces** are Solo groups. Repositories, pull requests and issues are a
  separate destination (`buzz.repos`), not a container of chats.

Display names ("Solo", "Team", "chat", "workspace") are presentation; code keys
behavior on the label, so a rename touches copy only.

## Current behavior

- Solo workspaces and workspace filing live in the existing encrypted,
  account/community-scoped `groups:me` preference record. Messages groups remain
  independent. Records from before the label also list a `channels` placement
  array; it is ignored and dropped on the next workspace write.
- Deleting a workspace tombstones its `me-section-<sha256(id)>` defaults record,
  emptied and renamed, best effort after the groups write. If that write fails,
  the record stays live but unreachable. A delete retried after a groups write
  that landed unconfirmed finds the workspace gone and still writes the
  tombstone. Saving another workspace's defaults meanwhile is unaffected.
- **Label only:** a private channel without `buzz.solo` is an ordinary Team
  channel, whatever its `about` text. No code reads the retired
  `Buzz session (buzz.sessions/v1)` marker, and there is no migration,
  membership revocation or transcript copy for channels created before the
  label.
- Workspaces are existing Solo workspaces, and Chats are ordinary private channels. New
  chats use ordinary private channels. The first send creates the chat, moves
  the draft into that chat's ordinary composer draft, applies workspace setup
  (Canvas, workspace filing, default agents), then sends through the same
  admission as any Solo send: missing tagged agents are added, then the message
  is queued. Nothing about the start is saved separately. A retry in the same
  view reuses the requested channel; after an interruption the chat exists with
  the text still in its composer. A start the relay refuses makes no chat: the
  chat and what was sent in it are withdrawn, and an error says why. If New
  chat is still blank (no text beyond tags, no files, settings and workspace
  unchanged, Chat settings closed), the prompt, its mentions or the agents
  picked for it, its files, the draft settings and the workspace go back into
  it. A draft begun since is kept, even one that couldn't be saved or an
  earlier refused prompt, and the new prompt is lost, as it is when it can't
  be saved on this device. The error says which happened, and names anything
  else of the prompt's that couldn't be saved. Setup that fails or is
  interrupted leaves a working chat without that setup; it never holds the
  message. Draft settings remain local until first send and use Solo's
  defaults namespace.
- New Solo chats are created with the `buzz.solo` label and no `about` text, so
  a relay without NIP-CL labels cannot start one. The label is a routing hint for
  agents: answer as one channel-scoped, top-level conversation. It is not access
  authority. The in-app agent harness reads it from the channel list; remote
  harnesses that only read `about` need to learn the label.
- The Buzz tools' `channel_create` with `solo` sends the same create for any
  caller, including the standalone stdio server: signed by the caller, with the
  label and any `members` it names. The caller is the creator, so an agent's
  key makes a chat its human members see as shared, not their own. It sends no
  message, so no agent turn starts, and it does not file the chat in a
  workspace. It cannot check NIP-CL support first, so on a relay that drops the
  label it reports an ordinary private channel instead.
- **Share** opens the same access dialog from Solo and Messages. This flow
  preserves channel ID, history, Canvas, existing members,
  Solo label and workspace filing. It neither promotes a conversation nor
  navigates to Messages. Done with no channel selected makes no writes; Convert to channel lives in the
  chat's actions menu and opens the explicit visibility confirmation.
  Name and lifetime are not sharing controls.
- **Chat access** adds a person immediately, without a DM or link delivery;
  the owner can also add agents there (below). Search for a channel and click
  **Share** beside its result to make the
  Private chat View only and post a link, after confirming full-history and
  Canvas disclosure. View only chats confirm link delivery and keep their access;
  Public chats post directly. Pasting an owned Private or View only chat link
  uses the same confirmation before sending the original message. Opening the
  link creates no sidebar entry.
  Current access is grouped into **People** and **Agents** like a channel, with Owner and Admin tags. Future
  joins/departures are not synchronized. Copy link grants no access; Done with no
  channel closes without writes. Shared uses verified membership and cached human
  evidence, not privacy inference or a required role refresh. See
  [sharing](sharing.md).
- Naming and lifetime belong to [Chat settings](#chat-lifetime),
  not Share. Solo's View only / Private choices reuse channel policy;
  View only uses the relay-enforced Guest default;
  individual invitation role choices, dynamic inheritance/revocation and synced
  grant provenance remain deferred. Sharing does not expose owner-private detailed agent
  activity or start an agent. Proposal documents remain design history, not
  implemented behavior.
- Solo chats and drafts use the full conversation pane. Right-click,
  Shift+F10 and overflow share one sidebar action list: Mark as unread, then
  Rename (where editable), Chat settings and Move to, then Share access, Copy link
  and Convert to channel (where eligible), then Archive chat and Delete chat. Opening a row
  menu does not select the row.
  A chat can also be dragged with a pointer onto another workspace or **Chats**;
  the drop is the same Move to intent, with the same gate, optimistic placement,
  rollback notice and Retry. Like Messages' empty Starred, a hidden empty
  **Chats** section is not revealed during a drag.
- **Archive chat** (⌃⌘A on Apple platforms, Ctrl+Shift+E elsewhere; rebindable in
  Settings → Shortcuts) opens the Chat actions Archive confirmation for the open
  chat, including from the composer, after a fresh permission read; it does
  nothing where current relay state permits no Archive. Success returns to Solo. Archived chats
  are restored from search and Channel Settings, as before.
- The owner can add agents from the same **Chat access** search without sending
  a message or starting a run. The chooser uses the same available agents as
  the composer, excludes current members and archived agents, and confirms the
  signed roster before reporting success. Additions grant access to the chat and
  its history; people use the Solo share rule. Closing stops the dialog's continuation,
  while an already-sent membership request may still complete; reopening reads the
  roster, and retry uses the existing membership receipt.
- Solo chats use the ordinary composer with explicit
  recipient tags for both owners and guests. Saved chats offer the chat's people
  and your available agents; an untagged message never infers an agent recipient.
  Only available agents can be enrolled through tagging—outside humans must
  already have been shared into the chat. Empty new-chat drafts start tagged with
  the default agent for this account/community. **Agents → right-click or "..." →
  Make my bestie** explicitly saves that agent as the bestie; its card then shows
  **Bestie**. That choice is saved to the account as a private `main-agent` record,
  so every install adopts it once per session. Explicit choices and **Remove as
  Bestie** write the record. Removing saves a record of none, which is not the
  same as no record: a saved none means the account chose to have no Bestie, and
  no record means it never chose. A finished deletion writes no Bestie when a
  fresh account read still names the deleted agent. A different choice visible
  to that read stays; the read/replace cannot protect a concurrent choice on
  another device before publish.
  The choice stays until it is changed or the agent is deleted, and it is still
  tagged when its runtime is signed out or broken. Without a choice, or after the
  chosen agent is deleted, the first managed agent, then the first selectable
  agent, becomes the default agent and is saved on this device only, after the
  account record has been read, agent evidence is complete and the requested
  archive read has settled. A chosen agent missing for another reason is stood in
  for without replacing the choice. Until an agent is explicitly saved as the
  bestie, including for an automatic pick, a stand-in or a failed save, **Make my
  bestie** stays offered. When the Bestie plugin is enabled, the explicit
  account-saved choice also owns its pinned sidebar destination; automatic and
  stand-in defaults do not. The pinned destination reuses the newest verified
  one-to-one DM whose only other member is that exact agent, opening one through
  the shared DM service only when none exists. It is an ordinary DM with the same
  history, draft, threads and unread state—not a Solo chat or a second message
  store. While promoted, that DM is omitted from the ordinary Messages inventory;
  replacing or deleting the Bestie, disabling the plugin, or losing the exact
  roster match restores the ordinary row. The pinned navigation row adopts the
  agent's name and avatar. Global search shows the same identity with **Bestie**
  as supporting text and matches either name; the separate agent result remains
  a **New chat** action rather than another route to the pinned DM.

  Nothing is picked until the account record has been read and its archive read
  has settled, so a new chat is never tagged for a stale pick. A new chat tags the
  current default once each time it is shown; the tag isn't saved until the draft
  is edited, so showing an untouched new chat again uses the current default.
  Archive rereads, failed rereads and reconnects keep the last known archives, so
  a known deletion is never forgotten and a live
  choice never disappears.
  Follow-ups keep all exact agents notified by the previous send, just like
  Team threads, including the shared Remember mentioned agents preference.
  The account default never replaces recipients in an existing chat.
  Removing or replacing a tag is respected for that draft, including after
  leaving and reopening a linked draft. Alone with agents, Send and Enter require
  a tagged person or agent in saved chats; new-chat drafts still require an
  agent. Once another member has a loaded, non-agent profile, an untagged message
  sends as conversation; a member whose profile is missing or still loading keeps
  the requirement, and the send rechecks the fresh roster first. Existing signed-send recovery preserves its recipients. Human-only
  messages notify only the selected humans and do not carry human tags into the
  next draft. A blocked Enter shows “Tag a person or agent to send” in saved chats
  and “Tag an agent to send” in new drafts. The workspace control follows the editor tools on the same rail;
  model/effort controls read the explicitly tagged recipients.
- The agent's harness can name a Solo chat with its own title for the
  conversation. Claude Code offers its generated session title after its first
  successful turn, adding no model request. goose names the chat's first session
  itself, with one naming call, unless goose's config sets
  `GOOSE_DISABLE_SESSION_NAMING`, which leaves the chat its first-message name;
  a session reopened for the same conversation keeps a fixed title, except after
  an app restart. Codex, whose app server names nothing, runs one ephemeral
  read-only title turn on its small title model alongside a new conversation's
  first turn. Only the first tagged agent on the owner’s original
  message can propose the title, even when a retry has different words or tag
  order; the chat must still have its original first-message name. A bounded
  verified read checks up to 100 owner messages through the triggering turn.
  Full, missing, unsent or ambiguous same-second history leaves the title
  unchanged. Human names are never replaced. The rename uses the owner's ordinary
  channel-details save with revision validation, and logs why it skips a chat. Live/native title acceptance is
  a separate gate from unit tests.
- Solo rows share Team's working-agent signal, animated indicator and activity
  popover, including owned-agent typing in threads and unread-thread actions.
  Agent activity opens the agent's profile in the conversation's panel workspace;
  exact-message/thread actions use the canonical channel reader. Solo workspaces and
  row menus remain independent of Team's sections.
- A Solo chat uses the Messages conversation page: the same secondary
  conversation/tool/panel tabs, pane geometry and tab persistence as any channel.
  Its main timeline is full width, with no main-pane tabs, so its threads open
  in the side pane. A single working agent's Activity
  indicator opens its profile's Activity tab locally; multiple agents or an
  unavailable profile retain the chooser. Secondary conversations of the owner's
  Solo chat keep the same owner-scoped explicit recipients; nothing waits on the
  encrypted workspace record to send. A guest in a shared Solo chat keeps the chat
  treatment with the ordinary composer. Routes and labels never grant access.

## Organization, settings and recovery

Solo workspaces, assignments and workspace defaults never fall back to Messages defaults.
Workspace folders, optional worktree/base branch and Canvas are instructions saved
in ordinary Canvas Markdown; saving settings does not create a worktree or change
an agent process. Templates are copied into each new chat, not live-linked.
Switching a draft to another workspace reloads its Workspace/Canvas defaults while
retaining its independent name and lifetime. Moving
a saved chat only changes its workspace assignment. Saved conversation
settings retain the existing Canvas revision checks and explicit conflict recovery.

Solo workspaces use one bounded 16 KiB recipe record. Only workspace assignments
occupy it, so unfiled chats cost nothing; a full record refuses the filing and
keeps the chat. **Convert to channel** is a
separate, owner/admin-confirmed action for Solo chats, available from
Share and the existing menus. Its Private / View only / Public choice starts from
the chat's current access, with the same descriptions as channel general access.
It appears in Messages with the same ID, history, Canvas, membership, labels and
lifetime.
Conversion is one signed details edit that clears `buzz.solo` (keeping any other
labels) and applies the chosen visibility and admission policy; the chat moves to
Team for everyone.
It then removes the chat's workspace assignment, if any, and opens the channel in
Messages. Share alone never does this. If unfiling fails, Finish conversion
retries only that step. The existing preference owner preserves other workspaces
and assignments. Deleted/archived chats can still hold an assignment. No
cross-device atomicity, automatic compaction or new storage protocol is claimed.

Share attempts retain in-process intent plus durable per-operation Outbox receipts,
not a persisted composite transaction. Start over forgets settled choices, not
submitted operations, confirmed access or workspace filing.
An interrupted link can be retried by its exact ID in Outbox; confirmed delivery
can be removed there before sharing to the same destination again. Unknown
receipts remain protected. Whole-share intent does not survive an app restart.

## Chat lifetime

Lifetime is separate from Share. Before first send, **Chat settings**
offers the existing Ongoing/Temporary duration control for new-chat drafts:
Ongoing means no automatic archive; Temporary defaults to seven days and archives
after the selected duration without activity. Existing custom values are retained.

The validated `ttlSeconds` is sent as the third `channelWrites.create` argument;
there is no create-then-edit. Local settings store name, Canvas and lifetime
together. Invalid stored durations are visible failures, not implicit Ongoing.

A draft with no saved lifetime follows the default from **Settings → Local
settings → New Solo chats**, stored on the device for each community and account
and read again when the chat starts. Choosing a lifetime in **Chat settings**,
including Ongoing, saves it for that draft; saving with the shown default
unchanged keeps following the default. A default other than one of the offered
durations is read as Ongoing, unlike an invalid duration saved on a draft.

The **Chat settings** gear in the header opens the form directly; Solo chat
row menus offer the same form as **Chat settings**. Both open one
scrollable dialog, with **Chat name** above Workspace/Canvas
(optional for a new draft),
**Lifetime** below it, and one **Save changes** action. There is no separate
lifetime menu or tab.
Changed Canvas confirms first, then changed name/lifetime use one fresh signed
channel-details operation. The Solo label, privacy, history, membership and
workspace filing remain unchanged. A no-op closes without writing. If details fail
after Canvas confirms, the dialog keeps the choices
and retry skips that confirmed Canvas revision. Partial confirmation is explained
as an error, not presented as two independent normal save states.

**Cancel** in new and saved **Chat settings** and **Workspace settings** discards
without asking. Close, Escape and, except in a new chat, backdrop clicks close untouched
forms at once; changed ones first show **Discard changes?**: **Keep editing** (focused)
or Escape returns to the intact form, and **Discard changes** closes it. A failed save's
local draft or a name/lifetime save awaiting **Check save status** closes without
asking: reopening restores it. A typed, unadded folder path is not part of the draft.

Conflicts require explicit Reload while retaining the selected lifetime; an
unconfirmed save survives modal remount and relabels the single primary action
**Check save status**, without republishing or implicitly saving other draft
changes. Workspace drafts keep their existing revision and conflict recovery.
Workspace defaults are unchanged; a chat without the Solo label has no lifetime control.
Archived, cached, read-only or unauthorized lifetime writes remain excluded or
denied by signed details. Canvas/lifetime capabilities can be independently
unavailable; a failed read never sends an inferred default lifetime.

Closing/retiring a view fences later lifetime admission and late UI completion.
Canvas remains session-owned: navigation does not guarantee cancellation of its
internal preparation or already dispatched write. No atomic rollback or composite
app-restart journal is added. Native GUI, packaged/live-relay and renewed human
acceptance remain separate gates.

Solo settings use the ordinary details command `h,name,about[,ttl][,t…]`. A
chosen name sends the full label set, keeping `buzz.solo` and any other labels.
Unchanged lifetime omits `ttl`; a changed positive canonical decimal
(1–2147483647) sets it, and an empty value removes it. Settings always omit
visibility. Creation permits a positive TTL; empty creation TTL is rejected.
Browser and native signing and publish guards enforce this syntax independently.
The shared fresh-details owner remains edit authority.

## Optional naming

Double-click an editable Solo chat’s sidebar row, or choose **Rename** from its
actions menu, to rename it inline. The current
name is selected; Enter or clicking away saves, and Escape cancels. Empty or
unchanged names keep the confirmed title. Errors retain the draft below the field;
uncertain saves offer **Check save status** without republishing. This uses the
same signed details owner as Chat settings, retaining lifetime and other labels.

New and saved Solo chats use the same Chat settings form. A blank new name retains
the first-prompt automatic title (80 code points, canonicalized like relay names).
Explicit names use the shared canonical 1–120-code-point validation.

Name/lifetime edits keep the Solo label; only explicit Convert to channel clears
it. Chosen names are recorded using the existing NIP-CL channel label
`buzz.session.named`, added on explicitly named creation or an actual saved name
change. Existing labels are preserved. This requires relay channel-label support;
unsupported chosen-name writes fail before signing. Automatic-name reset remains
deferred. Older chats without this label use a short ID in shared cards until
a name change records the chosen name; the app does not infer provenance from a
prompt or historical title.
Clearing a saved name silently preserves the last confirmed title without a name
write or validation error. Other settings can still save.
The form uses the shared content-sized dialog and its normal footer spacing, with
one body scrollport and no reserved bottom area. The title and actions stay visible
in ordinary short windows. If enlarged controls cannot fit, the outer dialog also
scrolls, retaining space for a complete body control and pointer access to actions.
Name, Workspace folders, Canvas and Lifetime use consistent 32px section spacing;
labels sit 8px above their controls.

Naming uses the existing fresh signed authority/version check and exact full details
readback. Conflicts retain input for explicit Reload; an uncertain name/lifetime save
is checked without republishing or implicitly saving newer Canvas drafts.
Synthetic signed create/rename/readback coverage is not live cross-version-client
acceptance.

Generated sharing messages use `[Chat: <chosen name or short ID>](buzz://channel/<id>)`.
The chat's current name, including its starting title from the first prompt,
replaces the ID. Existing signed messages
and recovery receipts keep their original bytes, including legacy `Session ·` labels;
retry matching uses the original chat destination rather than regenerating the
current name. Authorized viewers can see the current chosen name in the card.

Links to Solo chats render as document cards outside the message bubble, before
any caption, with the fixed `Chat:` label, a chat bubble and a trailing chevron when readable.
Unavailable cards retain a lock. Legacy Session-labelled cards remain supported.
In the composer, references are staged
above the caption editor with a remove control and saved in the same draft. Sending
serializes the references before the caption as ordinary Markdown links. Selected
mention identities remain bound to caption text; quoted, list, code and hidden
references stay in their original context. Replies, reactions, copy and actions
remain owned by the original message. Navigation and access rules are unchanged.

## Owners and validation limits

`src/bundled/channels/ChannelsPage.tsx` owns every conversation, including the
Solo treatment (`SoloHeading`, the shared `ChannelMembersDialog`) and drafts; `SoloWorkspaces` and
`features/channel-navigation/SoloInventory.tsx` own the Solo half of
`app/shell/PrimarySidebar.tsx`. Drafting, settings, sharing and conversion live
in `src/features/solo`; Solo workspaces use
`src/features/relay/solo-preferences.ts` and the existing recipe capability.
`src/features/solo/labels.ts` owns the Solo label (`SOLO_LABEL`,
`soloLabels`, `ownSolo`). Existing channel,
membership, signing and Outbox owners retain their authority.

Colocated tests cover admission, frozen defaults, navigation lifetime and recovery;
browser fixtures exercise actual app wiring in Chromium and WebKit with synthetic
identities. They do not prove native signing, live persistence/restart,
cross-device/plugin fallback, real-agent effects or opening performance.
Those checks and renewed human acceptance remain delivery gates where applicable.
See [sharing](sharing.md) for the contract.
Human testing, packaged/native GUI, live relay, cross-account, no-wake and hosted
CI acceptance remain separate. Narrow enlarged-text footer clipping/wrapping
remains a presentation limitation; center hit testing and Tab reachability are
not complete visual acceptance.

## Start a Solo chat from a channel or message

**Start Solo chat** in the existing channel/message menu opens an isolated
ordinary Solo draft, with the selected message (or channel) link visibly in the
editor and the default agent tagged. The link is normal editable message content:
it can be removed, changed, or supplemented, and is sent exactly as authored. No
permanent origin field, extra source paragraph, automatic source access or
transcript copy remains. The shortcut uses ordinary Solo creation; it needs no new
relay capability. The chat stays private until it is shared through the existing
Share flow. A leading source link is not used for the chat's starting title.

Source permissions still apply when an agent follows the ordinary link; seeing a
link does not mean it can read or post in that source. Rendered, live
cross-account, restart and real-agent acceptance remain separate from focused
component/service tests.
