# Sharing a Solo chat

Sharing uses ordinary channel visibility and signed membership. Solo project
filing is private client-side organization, independent of access; see
[Solo](README.md).

## The model

- A Solo chat is a channel with the `buzz.solo` label.
- Channel visibility and signed membership control access. Direct invitations
  add members; sharing from Chat access to a channel opens community reading.
- A shared chat link is an ordinary message containing
  `[Chat: name](buzz://channel/<id>)`. It renders as a chat card when the target
  is a Solo chat; the `Chat:` label lets a viewer without access see it as one.
  Links carry no other share marker, and older `Session:` labels still render.

The access dialog has two ways to share:

1. **Add a person**: one membership grant, no message.
2. **Share with a channel**: make a Private chat View only, then post its link.
   View only chats confirm delivery without changing access. Public chats post
   directly and keep their access.
   Channel members and their agents can read without joining. Opening the link
   creates no sidebar entry. This is community-wide reading,
   not access limited to the chosen channel.

## Access dialog

The Solo chat header's **Access** button and the conversation-row **Share…** action
open the one access dialog every conversation uses (`ChannelMembersDialog`). In a
Solo chat it is titled **Chat access**, with the chat name as its description.
Share stays in the same conversation: no promotion to a channel,
Solo removal or automatic navigation to Messages. **Convert to channel** lives only
in the chat's actions menu. **Copy link** sits at the footer's leading edge and
copies `buzz://channel/<id>` only; its hint explains that copying grants no access.

One search field (accessible name **Search people and channels**, or **Search
people, agents and channels** for an owner who can add agents) filters current
access and lists people under **Not in this chat**, each with an **Add** button;
Enter adds the highlighted person. Adding is immediate and uses the Solo share rule
(`canShareSoloChat`), with per-person **Adding…**, error and **Retry** states. The
owner's selectable agents are offered too and join as Bot, even with a Guest
admission default, without starting a run. Composer mentions use the same grant.
Where the viewer cannot add agents, a note says to mention an agent in the chat
instead.
Current access uses the channel groups (**People**, **Agents**) with Owner and
Admin tags, and each row has the channel members' actions menu, so the chat owner
can remove someone. The verified roster shows loading or failure, never treating a
failed read as an empty audience.

Invitations use the same groups and controls as channels: **Your agents** first,
then **People**, **Other agents** and **Your other agents**, omitting empty groups.
Solo still excludes agents the viewer cannot add directly. Each group uses shared
name, relationship and usage ranking, begins with four rows, and expands with its
own **Show more**. Only the viewer's client agents are suggested without typing,
and only while the viewer is the sole member. With anyone else in the roster,
search is required to offer invitations. Search still finds people and channels
for sharing; this presentation grants no additional authority.
Solo and channels intentionally share the device-local `channel-members` usage
picks, so a choice in either surface can improve its order in the other.

While searching, eligible stream/forum channels appear in a **Channels** group.
Each result has a **Share** action. It checks current access and opens a
confirmation titled **Share this chat?**. It first states the chat changes from
Private to View only and its link will be posted in that channel, then discloses
community reading of the full history and Canvas. **Share** saves that
access and posts the link in one step. A chat already set to View only gets a
similar confirmation explaining link delivery; Share posts the link without an
access write. Public chats keep their access and post directly.
Cancel returns focus to the same Share result and preserves the search.
The toast says **Chat changed to View only. Shared in #channel** when Share
changed access, or **Shared in #channel** when access was already open. Both
offer **View**, which opens the posted link. **Done** closes the access dialog
without writes.

An access failure leaves the link unsent. An uncertain access save offers
**Check access and share**: it checks the existing write without resending, then
posts the link only after confirmation. If link enqueue fails after access was
saved, the chat remains View only; **Retry share** checks access and retries the
link without another access change. Once queued, delivery and retry belong to
the ordinary Outbox. Direct invitations remain separate and keep their roles.

People invited together (a team, mentioned nonmembers or brought agents)
go in one kind 9000 per role, at most 100 each, and the roster is read once after.
A relay without batch support adds only the first person an event names, so the
roster decides who was added; anyone else, or anyone with an earlier addition
still pending, gets the single addition, which reports their own failure. A batch
is never resent, and stays in Outbox until everyone it names is in the roster or
has their own addition; its **Retry** checks each person again. See the
relay's kind 9000 entry in block/buzz `NOSTR.md`.

The sidebar's Shared mark is status only: it uses the verified current roster and
cached non-agent evidence for an additional human. Unknown profiles remain
unclassified; absence of the indicator is **not** a privacy promise. Clicking the
indicator opens the same dialog.

An invitation saved by an older client without an explicit Member grant is never
replayed as a participation invitation. **Retry** keeps it protected during the
relay's 15-minute intake window. After expiry, Retry fences local delivery and
checks the original event ID with a fresh strong read. Verified absence can
resolve it. If the command is recorded, a fresh signed roster reconciles its
result. If that person has since been removed, Outbox **Retry** durably clears
the old row without re-inviting them. An explicit **Add** from People still
re-invites them in one action, including when the old receipt remains. Add finishes its fresh
membership check before atomically retiring the original and saving a new
explicit Member invitation. Closing or restarting keeps either original recovery
or the replacement receipt. Failed reads or storage, active delivery, and an echo
contradicting negative readback keep recovery. This uses the existing Outbox/member/share actions, with no
background retry or new control. If signed roles confirm that the earlier invite
admitted a Guest, remove that person in People and invite them again. Recovery
never silently promotes an existing Guest. A definitively failed invitation can
also be replaced after explicitly dismissing it in Outbox.

### General access

The access dialog's **General access** offers **View only** and **Private**.
Public is not offered. Participation through this UI is by invitation. Existing
members keep their individual roles when the general policy changes.

View only makes the chat's full history and Canvas readable by the community.
The confirmation names this disclosure, including workspace folder paths and
agent instructions stored in Canvas. Moving from Public also
explains that people already in the chat keep their access. Moving from View only
to Private warns that joined viewers remain members unless a verified role
snapshot establishes that no Guests exist; loading or failed verification keeps
the warning. Public → Private also warns that joined members retain
their access until removed in People. One signed kind-9002 edit sets
`visibility=open` and `join_role=guest` together, through the existing
`channelDetails` save, conflict checks and exact readback.

Omitting Public here is a UI restriction, not a relay or harness safeguard.
CLI/MCP or another client can still set a Solo chat to Public with Member
admission. The dialog shows **Public** for that policy and lets the
owner change it to View only or Private. The confirmation warns that the picker
cannot switch it back to Public. Public members can still post and
address the owner's agents, and can replace the shared Canvas. Agent wake and
owner-Canvas hardening are separate follow-up work; this picker does not fix
those risks. Changing to View only restricts new people, not existing members.

With View only, visitors can find the chat by name in Search Buzz or open its
ordinary chat link. They read without joining and cannot send messages, react or wake agents.
The relay's ordinary Guest/default-Guest write policy enforces this boundary;
the absent composer is only its client presentation. View-only access grants no
membership and adds no sidebar entry for a visitor. **Join** adds a visitor as a
Guest, listed in People as **Viewing only**.
The chat then appears under Solo/Chats with normal unread tracking; notifications
follow existing settings and mention/thread rules. It stays read-only. **Leave
chat** removes membership and the sidebar entry; an open chat can still be read
without joining. The owner keeps the same Solo label, conversation ID and private
workspace filing.

Changing back to Private stops nonmembers from reading; it does not remove
members or change their roles. Guests who joined while the chat was View only
keep read access until they leave or are removed in People.
Reading without joining creates no membership to retain. Changing the General
access picker alone does not change invitations, post a share message or add
notifications. Unconfirmed publication uses **Check save status**, without
automatically resending.

## Sending a chat link in a channel

Pasting a recognized Solo chat link into a composer stages it as a chat card.
Sending the card into a channel, thread or DM uses the same policy as Share.
For a Private chat you own, **Share** confirms community access to
its full history and Canvas, opens reading, then sends your original message.
**Cancel** leaves access and the draft unchanged.

View only chats you own get a link-delivery confirmation and retain their access.
Public chats send without a prompt and retain their access.
Links to chats you do not own also send without changing access; recipients still
need their own permission to read. Solo destinations retain their existing send
behavior. Direct person/agent invitations remain available in Chat access.

Multiple owned Private or View only chats in one message are named in one
confirmation. Only Private chats need an access edit. If an
access save fails, the message stays unsent. Retry skips chats already opened;
if a chat's access or details changed while consent was open, the confirmation
reloads its current policy and requires **Share** again before continuing.
**Check access and send** checks an uncertain save without resending it. Any
access change already saved is kept when you cancel or a later step fails.
Changing the draft or leaving stops further access writes and message sending;
an already-dispatched access change may finish. Ordinary Outbox delivery owns
recovery after the message is queued. Future destination membership is never
synchronized into the chat.

## Explicit conversion, separate from Share

The product owner approved this distinction on 2026-10-14: **Share** keeps the
Solo label and project filing; **Convert to channel** removes the Solo label and
the initiating viewer's project filing, so the same conversation becomes an
ordinary Team channel, with Private, View only or Public access. It changes
organization and conversation behavior for every member, never creates a new
conversation or copies history.

The Solo chat header overflow and the Solo row menu offer **Convert to channel**
for the viewer's own Solo chat.
`src/features/solo/ConvertToChannel.tsx` reuses the shared Dialog, Select
and Button, with the same Private, View only and Public options and
descriptions as channel general access. The current access policy is selected
initially. Choosing View only or Public for a private chat discloses community
reading of its full history and Canvas, including workspace folders and agent
instructions. View only saves public visibility with Guest admission; Public saves
Member admission; Private keeps reading restricted to members and retains the
current admission default. Choosing Private for an open chat warns that joined
people retain access until removed in People, using the same warning as General
access. A selected share channel is never granted by conversion.
Cancel writes nothing and returns focus to the retained initiating control.

The sequence is explicit, not atomic:

1. Confirm one signed kind-9002 command through the existing `channelDetails`
   owner. Fresh metadata, owner/admin authority, conflict checks,
   altered-signature rejection and exact readback remain unchanged. The edit
   removes `buzz.solo` from the channel's labels and applies the chosen
   visibility and admission policy; name, lifetime and other labels are preserved.
2. Refresh Solo projects and, if this viewer filed the chat in one, clear only
   that assignment through `soloPreferences.assign(id, undefined)`. Its encrypted
   account/community record, serialization and Outbox own persistence. Other
   projects, conversations, defaults, memberships and other people's filing are
   untouched.
3. Announce **Converted to channel.** and open the same channel ID in Team. No
   new grant, notification, agent wake or transcript write occurs.

The form lives outside the disappearing Solo row. Replacement-composer autofocus
does not steal its focus. Actual navigation, connection replacement and unmount
fence subsequent steps and late completion; already-enqueued writes still belong to
their existing durable owners. No completion navigation is sent to a superseded
visit.

### Partial success and recovery

An uncertain metadata publication offers **Check status**, never automatic resend.
The pending details owner retains the exact selected access policy; **Reload chat
details** recovers failed reads without losing that intent. If another details
surface confirmed the publication, fresh matching metadata can advance the retained
conversion receipt without another kind-9002 command.

`conversion.ts` retains only chat-local orchestration intent and the confirmed
metadata phase, with a shared running guard. It is not permission evidence or a
persistent transaction. After the label edit succeeds but project unfiling fails,
the dialog says **Channel converted. Finish removing it from its Solo project.**
**Finish conversion** re-reads details, confirms the label is gone and the
settings are unchanged, and retries only the preference write. Failed reads keep
the recovery entry. A verified superseding settings edit retires an unconfirmed
conversion receipt, including after Reload or reopening the dialog; it does not
rewrite those settings or remove project filing. Restart loses the
orchestration receipt, not access or the channel: the conversation is already an
ordinary Team channel, and a leftover project assignment for a channel without the
label is ignored by Solo.

### Ordinary behavior after conversion

Without the label, every member and agent reads the conversation as an ordinary
channel. Subsequent Claude/Codex/native-runner turns use ordinary channel
reply/typing policy. Already admitted turns retain their frozen policy;
conversion does not cancel running work. No runtime rewrite or new agent authority
is added. Old Solo routes use type-correct composer flags and ordinary recipient
controls for an ordinary channel.

The same ID, history, Canvas, members, other labels and lifetime remain. Public
uses the existing `visibility=open` wire tag and does not introduce an enforceable
View-only role.

## Explicitly deferred or blocked

- **Create new channel** was removed from the Share dialog for this slice.
- Optional creation names, saved renames and standalone lifetime use the unified
  [Chat settings](README.md#optional-naming) form, not Share. Persisted naming
  provenance, automatic-name reset and dynamic link titles remain deferred.
  Old and new generated links keep their numeric labels after a rename.
- Individual **Can view / Can participate** invitation choices remain deferred.
  View-only Solo sharing uses the channel's relay-enforced Guest admission default,
  without changing existing individual invitations or roles.
- Direct-person DM/link delivery is not implemented. Access grants alone are not
  a dedicated invitation or share notification; explicit automatic handoff needs
  a separate product decision.
- Dynamic destination inheritance/revocation, grant provenance and removal
  permissions remain unimplemented. Standalone creation/lifetime editing belongs
  to Chat settings, not a dependency of sharing or conversion and not a Share
  option. No provenance is inferred from links or membership.

## Validation

`share.test.ts` covers the shared Private-only access policy, exact save recovery,
authority/ownership changes and destination admission.
`ChannelMembersDialog.solo.test.tsx` and `chat-link-sharing.test.tsx` cover the two
entry points, no membership grants, failed/uncertain access, draft cancellation,
partial multi-chat recovery and original-message delivery. Existing direct
invitation and Outbox receipt coverage remains separate. Live relay ACLs,
cross-account discovery and no-wake behavior are separate checks.
