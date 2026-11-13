# Buzz quick guide

Use this guide when helping someone use Buzz. Explain in their terms, not
implementation details. This is an overview, not a complete feature list. Use
current app context and available tools to check anything it does not cover.

## Start with useful work

Buzz is an open-source app for thinking, asking questions, and getting work done
with agents, alone or with other people. Start with a real task: work through an
idea, draft something, answer a question, or make a plan. Customizing an agent is
optional, not an interview someone must finish before getting help.

Keep a first explanation brief: Solo, Team, agents, and one useful next step.
Offer more detail when asked. Do not pretend to highlight controls or navigate
the interface unless an available tool actually supports that action.

## Agents in Huddles

On supported desktop hosts, a running local agent with voice support joins your
connected Huddle when it is also a member of that Huddle's room. Membership of
the parent conversation alone is insufficient. Several agents can participate.
Starting a Huddle in a one-to-one DM with your running voice-capable agent
adds it to the Huddle room; joining an existing Huddle does not. You can also
add agents through the Huddle's member controls. On the hosting computer, a
seated agent starts at normal size, shrinks by 20% while you speak, and shows a
rotating ring while it works (activity dots in the compact player). It returns
to normal size while speaking, with the same pulse as people. This state is
not shared with remote participants. The agent’s own client enforces who it
hears. Each filters for audio from your connected devices
and speaks to everyone. The current audio protocol can briefly misattribute delayed
audio when a connection slot is reused; this is not a strict privacy guarantee.
Other people or speakers near your microphones can also be heard. Simultaneous
audio from your devices is mixed together.
Voice work uses the same permissions as your text requests. Joining your Codex agent’s DM huddle from mobile can activate that agent on
this desktop. Keep Buzz and the Codex agent running here; the desktop microphone
does not turn on. Other calls on another device do not seat an agent here.
Leaving on every connected owner device closes the remote voice connection.
When you leave a Huddle you started, desktop also ends it if you are its only
human connected to audio and no additional device admission is visible. The ended card's
View action keeps the transcript accessible. Other connected humans or known
additional devices keep the room open.
If agent voice stops, the compact player and Huddle window show the reason;
leave and rejoin to retry.
Final voice transcripts appear in the room with speaker credit and do not
mention anyone. Explicit agent watches on that room can still receive them.

## Identity and getting connected

- If Buzz can’t finish starting, the window says **Buzz couldn’t open**
  instead of staying on the opening mark: **Reload** tries again, the desktop
  app also offers **Restart Buzz**, and **Details** holds the error for
  support. Your messages and settings are safe. A start that takes more than
  about 20 seconds says **This is taking longer than usual.** with **Reload**,
  and still opens by itself if it finishes. If Buzz hits an error it can’t
  recover from after it has opened, the window says **Buzz stopped working**
  with the same **Reload**, **Restart Buzz** and **Details**.
- Buzz uses a key-based identity. On first launch, the welcome screen offers
  **Create account** and **Sign in**, which open the Builderlab account page;
  when this computer already has a Builderlab sign-in saved, **Sign in** comes first.
  **Other options** reveals a **Community URL** field
  for an address or invite link; desktop does not offer QR scanning.
  With no communities yet, **Join** advances through full-page access and profile
  steps. Before joining, **Back** returns to the entered link; after admission,
  profile setup continues forward. An invite-code field appears for
  a supplied invite or denied access on a community that enforces membership;
  community policy links open separately. When you are signed in to Builderlab
  and the community is one it hosts, Buzz skips the age and terms boxes,
  because your account setup already covered them, and **Continue** joins
  straight away.
  On Mac, the welcome entrance plays once per app storage profile; Reduce Motion
  skips it, and pressing a key finishes it immediately.
  The key-import field masks your key. Use the eye inside the field to reveal
  or hide it.
  After Builderlab sign-in, an account with no linked key is set up
  automatically: Buzz creates a key (or uses the one already on this device)
  and links it to the signed-in account. Once a key is on this computer, Buzz
  opens straight to the app and reuses the saved Builderlab sign-in. If that
  account turns out to be linked to a different key, Buzz says so over the open
  app. When Builderlab has a backup of the account's key, **Replace** removes
  this computer's key and restarts Buzz to restore the account's; copy this
  key from Settings → Identity first if it isn't backed up; if the browser
  then signs in to a different account, Buzz stops and offers **Use a different
  account**. Without such a backup, Buzz only says where the account's key is,
  with **OK**. **Not now** or **OK** keeps this key, and Buzz doesn't ask again
  about the same two keys, unless the account's key later gets a backup, when
  it asks again with **Replace**. An existing private key can be entered from **Welcome back**.
  Its **Use a different account** signs Buzz out of that account; the next
  sign-in asks the browser to sign in again rather than reuse the account it
  remembers. Signing in to a different account than the one saved on this
  computer replaces it: Buzz restarts and signs you in again by itself. When
  the saved account may not be backed up, Buzz asks first: copy or reveal its
  private key and check **I have my key** before **Replace**; **Cancel** leaves
  it in place. If the key saved on this computer is malformed, Buzz offers
  **Remove from device** at launch: after you confirm, Buzz restarts, deletes
  that key on the next launch, and you can sign in to restore your account's
  backup or enter your private key.
  Builderlab setup backs the key up automatically;
  if backup fails temporarily, retry to complete setup. If backup is not supported
  by the build or account, choose **Continue without backup** to finish setup.
  Independent-community key imports
  without Builderlab sign-in do not upload a backup during setup. Later, while
  signed in to Builderlab on a build with backup, a key with no backup choice is
  backed up automatically if you belong to a Builderlab-hosted community;
  otherwise Buzz asks **Back up your key?**, again on the
  next launch or sign-in if the dialog is closed. In **Settings → Buzz → Identity**,
  the ID card shows backup status. Open **More options** at the top-left of its
  container for **Retry backup** or, while backup is off, **Back up key**, which
  opens the consent dialog. When the key isn’t linked to your Builderlab
  account, or the account holds a different key, the notice’s **Builderlab** link
  opens **Settings → Plugins → Builderlab**, where **Connect Buzz identity**
  links this key, or **Switch to this device’s identity** replaces the account’s
  key (this permanently unlinks the old one). While the account holds a different
  key, this device's key may also be refused when you use that account to sign
  in to a community. After signing in to the
  public Builderlab, **Connect to a community** also offers **Create a
  community** when that account is linked to this device’s key and may create one.
  Choose an available address, then **Create community** joins it right away,
  with no **Join Community** confirmation. Other Builderlab deployments do not
  offer it during setup. Later, **Create community** in **Settings → Plugins →
  Builderlab → Communities** opens the join for the new community at once; after its profile
  step it opens and is listed in the community picker. When the owner of a community with no channels yet
  opens Messages, Buzz creates one open **#general**, marked as the starter
  channel for new members, and opens it.
  The picker's **Create community** opens that form directly. If Builderlab is
  signed out, sign in remains available in both management sections; a picker
  creation resumes after sign-in.
  Existing community profiles are preserved and skip setup. A new profile needs a name; an avatar is optional. A returning account may restore
  its backed-up key where the build and account allow it. If the older Buzz app
  was used on this computer, a **Continue with your Buzz identity?** dialog
  brings that identity over without signing in; **Not now** keeps the welcome
  screen, and the offer returns after signing out. Use the options actually
  shown; do not invent a setup sequence.
- The **public key** identifies someone and is safe to share. Pasting
  someone's `npub` (with or without `nostr:`) or hex key finds them in New
  message, in ⌘K search's People results (Ctrl+K on Windows and Linux), in
  **Add people** and after `@` in a message. The **private key**, shown as an
  `nsec`, lets someone act as that identity. Never ask anyone to paste a
  private key into a conversation or send it to you.
- In native desktop builds, **Settings → Buzz → Security → Authorize external identity** creates an
  ownership proof for an application that holds its own agent key.
  Enter that application's public key in hex, select **Authorize identity**,
  review the exact identity and permission in the confirmation, then select
  **Authorize this key** and copy the proof into its owner attestation field.
  This lets the key direct your Buzz coding agents to run commands as you.
  Authorize only keys you recognize: the proof has no time or event-kind limits. Your private key stays
  in Buzz. This does not join the agent to a community or sign it in to an organization.
- The back of your Identity badge shows known backup and recovery details below
  the private-key strip and scrolls when its details run long. Buzz starts checking
  when the Identity page opens. The back always explains that the key is stored
  securely on this device. It names the backup account when this device has
  confirmed a backup of the key. Initial status loading stays quiet; a
  failed check shows **Backup status unknown** with **Retry backup** in the
  bottom action space on the back. This rereads local status and then starts a
  backup attempt for the current key
  when the read succeeds. It stays disabled and shows a spinner through both steps.
  The private-key menu contains
  the **Private key** heading above Copy and Reveal. A confirmed backup stays
  **Backed up** when a later attempt or account lookup fails, including offline
  or signed out, but not when the account shows another key linked and backed
  up. Unconfirmed failures show **Check backup**. **Retry backup**
  isn't offered where another attempt gets the same answer. With no sign-in,
  sign in on this page instead, which starts a backup on its own;
  a refused or unverifiable backup service has no fix in Buzz. A spinner appears only while a backup attempt is running.
  **Retry backup** uses that same space above **Remove from device** on the
  back and shows a disabled loading button during an attempt. A confirmed, settled backup
  shows **Backed up** with a destination tooltip. Only one recovery button
  appears at a time. Initial status loading shows no pill.
  **Remove from device** opens a confirmation before removing Buzz’s saved key
  from this device’s secure storage and signing out. Account backups and copies
  saved elsewhere stay. Other local data stays unless erasing is also selected.
- **Settings → Buzz → Identity → Copy private key** lets someone make their own
  backup, for example in a password manager. They should handle it privately.
  While it runs, Buzz tries to clear the copied key from the clipboard after a
  minute if nothing else was copied since, so paste it right away.
  When Builderlab backup is on, the same page shows the account's linked key
  when it is backed up and differs from this device’s key.
  For a key without a confirmed backup, account lookup failures use the card’s
  **Backup status unknown** caption and **Retry backup** action. Backups of other keys are not shown, and the row is read-only.
  Backup and restore options depend on the build and account; do not promise
  recovery or assume automatic backup is on. Losing every copy of the private
  key can mean losing the identity.
- **Settings → Plugins → Builderlab** shows previews of your hosted communities
  and remote agents. Open either card to manage it, then use the left caret beside the title to return. Both lists load when the overview opens and refresh
  when the window regains focus; opening a section preserves its current draft.
  Hosted communities have Active/Archived filters, name/address search and row
  menus for copying addresses and available management actions. **Create**
  opens the address form; quota and identity checks still govern creation.
  After **Copy address**, a hint appears above the row’s **…** menu without moving
  the list; Escape dismisses it. The **Refresh** icon beside search checks
  communities again, including after a failed read. Automatic
  refresh keeps the current list usable and waits while a community dialog is open.
  A green check beside Refresh means the Builderlab account is linked to this
  device’s Buzz identity; hover or focus it for details. The creation dialog
  focuses the address field and shows quota usage beside its actions. Archived
  communities still count toward quota until deletion cleanup finishes.
  Remote agents show their model and setup state.
  The title includes the count. Each row’s **…** menu offers **Copy key**.
  Saved agents show their community avatar and open their **Agents** pane when
  clicked, with **View Agent** also available in the menu. **In Agents** marks
  these available panes. **Configured** means Builderlab reports Active with a valid
  model selection; it does not indicate live presence.
  Creation dates and full keys are not displayed in this compact list.
  Load errors include **Try again**.
  Use **Open Agents** from the empty list to create one.
  In builds using a shared sign-in, Builderlab's account notice names the provider;
  **Manage account** opens Identity, where that sign-in is managed.
- Some organization builds ask you to sign in to your organization when Buzz
  opens, and again when that sign-in ends. Before it ends, a notice offers
  **Sign in again** so Buzz stays open. Finish in the browser and Buzz opens.
  The callback tab attempts to close after three seconds. On macOS, Buzz can
  regain focus after verification while the sign-in browser is still foreground.
  If the tab stays open, you can close it yourself.
  **Not now** opens Buzz anyway, but that organization's communities stay
  unavailable until you sign in. Sign-in, sign-out and when the current
  sign-in ends also live under
  **Settings → Buzz → Identity → Community sign-ins**.
- When a community requires organization sign-in, the sidebar or join dialog
  explains why and offers **Sign in with** the organization’s name or server
  address. Complete sign-in to reconnect; in the join dialog, choose **Continue**.
- The **Community sign-ins** cards show each configured server, its account
  and the saved communities that require its sign-in. Each **Sign out** asks for
  confirmation and ends only that server’s sign-in. The next sign-in to that
  server asks the browser to sign in again rather than reuse the account it
  remembers, even after Buzz restarts. Signed-out servers keep **Sign in**.
  **Renew sign-in** and the expiry date appear within seven days of expiry;
  its caret menu offers **Sign out**. While you finish renewing in the browser,
  the card says "Finish in your browser" with **Cancel**; you stay signed in.
  If Buzz couldn't check a saved sign-in, for example while offline, it keeps
  it and offers **Check again**. A Builderlab connection link opens its
  existing settings. Removing the Buzz key still ends all server sign-ins.
- Buzz apps on this computer that use the same organization server, such as
  Buzz and Buzz Staging, share its sign-in, like the private key. After you sign
  in in one, **Sign in** in the other finishes without the browser. Signing out
  or switching account in one also applies to the other. Signing out also ends
  that sign-in at the organization server, so an app that's already open asks
  you to sign in again the next time it uses it. If the server couldn't be
  reached, that app keeps its sign-in until it restarts.
- If a community doesn't accept the account you signed in with, its prompt
  names the server and offers **Switch account**: Buzz signs out of that server
  only and opens its sign-in again, which asks the browser to sign in again
  rather than reuse that account, so you can choose another one. Other servers stay signed in. It also
  names the other communities that require that server's sign-in, whose access
  may change with the account; ones that don't require it are unaffected. If
  you cancel the sign-in during a switch, you stay signed out of that server and
  the prompt offers **Sign in**. **Not now** closes the prompt and changes nothing.
- A community invite or address connects someone to a community; creating an
  identity alone does not grant membership. The same identity can be used in
  more than one community. To add another, choose **Join a community** in the
  community picker and paste an invite link or type an address such as
  `relay.example.com`; an invite link fills in its invite code. Paste the whole
  link there; a code on its own is refused.
- Community owners and admins manage access in the community's **Membership**
  settings (also reached from **Invite to community** in the community picker's
  right-click menu). **Members** shows the roster and updates as membership changes arrive.
  If loading fails, use **Retry**. Switch to **Invite** in the same screen;
  Back and Forward restore the visited Membership tab. Leaving Invite and returning
  creates a fresh link with the same expiry and use limits.
  Invite shows a QR code in the desktop app alongside the invite URL,
  **Copy link**, and shared expiry and use limits. On macOS, hover over the QR
  or focus its action with the keyboard to reveal **Share**, which opens the
  system share menu with a QR image and the invite link.
- To use Buzz on your phone, open Settings → **Mobile app** (**Pair mobile**
  in builds without Builderlab). When you're signed in with Builderlab and your
  account holds this identity's backup, it says to install the app (with store
  links and QR codes where the build provides them) and sign in with Builderlab
  there. Otherwise it pairs the phone with this identity by QR code and a
  verification code.
- Set or clear your status from the profile menu, or with **Update status** /
  **Set a status** on your own profile. On a profile or in the profile menu,
  hover the status emoji to see its `:name:`.
- Your profile shares your local time by default: joining a community, or
  opening one whose profile has never had a time zone, publishes this device's
  time zone name, such as `America/Los_Angeles`. Each device does this at most
  once per community. To stop, open Settings → **Profile** in that community,
  uncheck **Show my local time on my profile** and save. That opt-out is kept in
  your profile; if another app rewrites your profile without it, a device that
  has never shared there can share once more. Check it again to pick a time
  zone. People who share a time zone show their local time on their profile and
  its preview, with "tomorrow" or "yesterday" when their date differs from
  yours. With **Show time zone details on profiles** on in Settings →
  **Appearance**, it also shows how far ahead or behind you they are and their
  time zone name.
- Where a community verifies names, the profile check appears beside the verified
  full name, or the verified username when no full name is supplied. The profile
  shows the issuer and verification time; cached verification has no check.
  Verified names seen before show at once after a restart, as cached, until
  the community checks them again.
  When you search for people (search, @mentions, adding channel members and new
  direct messages), a verified person shows their verified name with the full
  name beside it. Search finds people by their profile names; once found, a
  verified full name also matches as you refine. Search and new direct messages
  also find people already verified by a matching verified name or username.
  Adding channel members also finds a verified person by their verified name,
  or by their public key, even if they never set up a profile.
- Profile names omit surrounding whitespace. Names with layout or directional
  controls fall back to a safe handle or public-key fragment. Names that match
  a loaded verified name after ignoring hidden characters gain a public-key suffix.

## Connect an external app

External apps are available only in communities enabled for this build.
Other communities cannot grant access.

Start setup in the external app. Buzz desktop shows an **Authorize app**
dialog. Select a community and an agent, then select **Authorize**. The app
gets full access as that agent: every Buzz tool the agent has, including tools
plugins add later, the Solo workers the agent may run, and changes to Buzz
settings on this device and to your Bestie. It gets the agent's Git access to
its community's repositories, can wake the agent in its conversations, and can
post any file
your account can read on this device, including outside the agent's workspace;
relative paths start in the workspace. An
agent that runs on an execution target reads files only in a conversation, so
the app cannot send its files. It can disable plugins at once; installing,
updating, enabling or removing one needs your confirmation. The app cannot
assume a current conversation. The app completes setup automatically. Keys stay
in Buzz. Only authorize an app when you started its setup. The displayed name
comes from that app. Protected agents cannot use this connection. Keep Buzz
open. An unavailable agent cannot authorize access. Enable its runtime plugin
or use the Buzz copy that runs it.

Use **Settings → External apps → Revoke access** to stop it; it asks you to
confirm first. Changing community or identity also ends access. If a
connection ends, start setup in the external app again. Never put connection
credentials in a chat or file.
Older apps asked for limited read, post or create access, which Buzz no longer
grants. Buzz shows an update notice for such a request; select **Deny**, update
the app and start setup again. A saved limited approval does nothing until you
approve full access.
External posts use the selected agent's identity. Replies and mentions reach
that agent in Buzz; they do not notify the external app through this connection.

## Pair a command-line tool

Run `buzz auth desktop pair` in a terminal while Buzz is open. It pairs for
the community open in Buzz; to pick another, add `--relay <community address>`
(before or after the subcommand), using the **Community address** shown in that
community's **Settings → Local settings**. A bare host means `https://`. The
tool skips copies of Buzz that aren't running. Buzz asks whether to let that tool use Buzz as
you; select **Allow** only when you ran the command. Buzz pairs only for a
community you've joined in Buzz, and otherwise tells the tool so without
asking. Until you've finished signing in or setting up Buzz, it refuses
pairing; finish, then run the command again. Once allowed, the tool can post,
read and use your sign-in through Buzz, and your key stays in Buzz. It can't
edit your profile, delete, or manage members, agents or moderation: do those
in Buzz.
**Settings → Security** lists paired tools. **Revoke** asks first, then stops one
until you pair it again. Signing out revokes all of them, and a pairing unused
for 30 days expires. If your sign-in expires, paired tools keep their pairing
and are asked to sign in again in Buzz.

## Conversations and communities

- Notification sounds and their Settings previews do not become media players;
  keyboard play/pause remains available to music and other media apps.

- In dialogs, a ring shows which button has keyboard focus, including when the
  dialog opens after a click. Enter or Space activates that button; Tab moves
  focus. The filled action button can be different from the focused button.
  Simple confirmations generally focus Cancel or the equivalent safe dismissal
  action, so Enter cancels. Some intentionally focus their primary action.
  Confirmations with a required field or checkbox start at the relevant control;
  the action stays gated until its requirements are met.

- Each reaction emoji has its own capsule. Hover or focus it to see everyone
  who reacted. Large lists scroll within the preview. With a keyboard, Tab into
  the list to scroll it; Escape dismisses the preview. Clicking the emoji adds
  or removes your reaction. Capsules you reacted with take your solid accent
  color; on your own messages they take a neutral gray instead. A reaction
  never shows a `:shortcode:` as text: it draws the community's custom emoji
  with that name, or a neutral smiley when there is none or its image can't load.
- In the fullscreen video viewer, comments and emoji reactions at the current
  frame stay attached to that video when you move through a thread's media.
- With **Voice Notes** enabled, use the microphone in the composer to record
  and attach a voice note. Sending requires ffmpeg on the host computer. Sent
  notes support playback and seeking; a note's duration appears once it
  starts playing.
- Long message bubbles use the available conversation width, stopping 32px
  before the opposite speaker’s avatar column. Short messages hug their text.
- Hover over a message to reveal the capsule above it: add a reaction, reply,
  copy its link, or open More. **Copy message** and **Forward message** are in
  More. Keyboard focus also reveals these actions; touch layouts keep actions
  inline.
- Right-click a message, including its timestamp, to open its More actions with
  **Reply** added; Shift+F10 or the Menu key opens it from a focused control in
  the message. Links keep their own menu; images, media and text you already
  selected keep the system menu. Touch long-press keeps text selection.
- Plugins can add actions to this toolbar. A link to an active plugin panel
  opens that panel in the conversation. If the plugin is removed, its actions
  and panel links become unavailable.
- **Forward message** in a message's menu sends its link to one person in the
  current community, with an optional note. Buzz sends it in your direct
  message with them, starting one if needed, and you stay where you are;
  select the confirmation notice while it's showing to open the forwarded
  message in that DM. The link previews the original message; the
  recipient still needs access to its conversation. Forwarding is unavailable
  when the connection cannot start DMs or the message has no link yet.

- Only explicit additions by another member and removals appear as centered
  channel notices; self-joins and voluntary leaves are hidden.
  Consecutive addition and removal notices collapse into one row between
  conversation entries, even across long gaps or midnight. Large or mixed groups
  keep one name per action,
  such as “Pinky and 182 others were added.” Hover or activate “182 others” to see
  the full, scrollable list of names. Messages and huddle entries split groups.

- If **Reconnecting to relay…** persists, install a compatible **Network diagnostics**
  plugin using **Settings → Manage plugins**, then enable it and open
  **Settings → Buzz → Network diagnostics**.
  The notice can cover background reads as well as a dropped connection. Info
  collects connection counts, handshake latency, reconnections, heartbeat
  timeouts, application RTT, frame throughput and failure rates. The metric window
  can show the last minute, five minutes or current capture. Regular traffic also
  supplies separate publication acknowledgement, native HTTP response, subscription
  first-response and catch-up timings, without sending extra requests. Handshake
  samples require a connection attempt in the capture/window; probe RTT requires
  an answered liveness probe, sent when idle or on wake, focus or network changes.
  Debug adds read outcomes, cancellation initiators,
  stage timings, operation IDs, and socket delivery metadata. Errors retain safe
  categories and bounded cause chains; unrecognized error text is redacted.
  Retry records show timer lateness; a detected scheduling gap alone does not
  establish that the computer slept. Trace adds protocol details. Debug and Trace
  stay selected by default, including when Settings closes. Optionally check
  **Return to Info automatically** and set **Capture duration (minutes)** to a
  positive whole number (initially 15). Changing the level or duration restarts
  the countdown; unchecking cancels it. These choices last for the app session.
  Disabling the plugin stops collection, diagnostic IPC and file writes. Silent
  pauses capture; resuming or clearing history starts a new measurement period.
  Detailed capture expiry keeps Info metrics running. Capture levels reset when Buzz restarts.
  Desktop capture starts a local session file on first activation in each app launch,
  without an entry-count limit. Disabled periods have no diagnostic history. The session-file path
  is shown in diagnostics. For help with Debug or Trace logs, start a Solo session,
  give the agent that path, and describe the problem and when it happened.
  Older files remain until you delete them; **Clear
  history** clears only the current session. **Export JSON** works while
  disconnected and streams the full current session to Downloads. The plugin installs on desktop. Browser development can exercise the host
  capability with a bounded in-memory history of frontend evidence only; it does
  not capture the Node broker's network history. Nothing is uploaded automatically. Exports
  omit message bodies and credentials but include relay addresses and connection
  metadata. See [reading network diagnostics](network-diagnostics.md) for event
  correlation and interpretation.

- **Solo** organizes your chats with agents. Choose **New chat**, select or tag
  an agent, and send a message. Solo conversations continue at the chat's top
  level rather than requiring a new thread for each reply. Where available, use
  **Model and effort** in the composer before sending; Solo keeps those choices
  for that chat until you reset them in the same control, even if its available
  models change. If a loaded catalog no longer offers a saved choice, the
  control explains what Send will use or which overrides it omits without
  clearing the saved selection. If no supported model is listed, Send omits
  model and effort overrides and uses the agent's defaults.
  Wait for saved choices to load before sending; an unreadable
  store never silently falls back to defaults. If choices cannot be read, use
  **Retry saved choices** before sending. If their agent catalog cannot be loaded, retry
  or reset them in the model control. If New chat cannot clear
  its choices after sending, reset them before starting another chat. Wait for
  pending model changes to save before sending. If saving fails, the current
  composer keeps your unsaved selection; other windows may not see it.
  If a refused start offers **Retry restoring message**, it keeps the original
  message, attachments, and choices while this window stays open. Retry never
  replaces a newer New chat draft or a later Reset. Reloading or dismissing that
  notice ends this recovery option.
  Open the composer’s agent chooser to change who you’re sending to. Already
  selected agents appear first with checkmarks when browsing; click one to remove
  it (the last agent stays selected). Rows stay in place while you toggle; reopen
  to refresh their order. Search ranks matching choices by relevance, including
  exact names.
  Plugins can keep separate unsent drafts in the same workspace. Where supported,
  each draft keeps its text, files, settings, model, and effort when you return.
  A locally hosted agent can list your personal workspace IDs with
  `solo_workspace_list` and explicitly choose one when creating a Solo chat,
  provided it includes you in the chat’s members. This only files the new chat;
  it does not copy workspace defaults or Canvas. A known pre-write refusal
  reports “created, not filed.” A write that cannot be
  confirmed reports that placement may have completed: inspect or refresh the
  reported chat before **Move to**, and never create it again.
  This option is not available through external/standalone or Nexus requests.
  Solo chats can also be shared with other people; do not describe every Solo
  chat as visible only to its creator.
  New chats start **Ongoing** unless **Chat settings** chooses **Temporary**,
  which archives the chat after a set time without activity. To start every new
  chat temporary, open the community's **Settings → Local settings** and choose
  a lifetime under **New Solo chats**: Ongoing, or Temporary after 1 day, 7
  days or 2 weeks. It saves at once and applies on this device to this
  community and account only. It covers chats started with **New chat**; a
  chat's own settings can still choose another lifetime, and existing chats do
  not change.
  Deleting or archiving the open chat keeps you in Solo and opens another chat
  or a new draft.
- **Team** contains community channels and their threads. Use the **@** picker
  to address a channel member. A full name typed after **@** and followed by
  Space or closing punctuation, such as `,`, `.` or `'`, selects that person or
  agent unless a namesake or a longer name that begins the same way could be
  meant; then pick from the list. A longer name of someone outside the channel,
  including one of your own agents, does not stop a channel member's name from
  selecting, so pick such a person or agent from the list: with a member named
  `Wes`, typing `@Wes Smith` mentions Wes, not `Wes Smith` from outside the
  channel. Likewise, with the agent `Claude` in the channel or Solo chat and
  your agent `Claude Code` outside it, `@Claude Code` mentions Claude. Pick
  `Claude Code` from the list to mention it: in a channel, sending then asks
  whether to add it; in a Solo chat, sending adds it without asking. Typing a
  name alone does not guarantee a notification. Selecting someone outside the
  channel does not grant access; inviting them requires an explicit decision
  from someone with permission.
- **Workspaces** group Solo chats and provide starting folders and instructions.
  With Nexus enabled, each workspace also contains its tasks and can have a Lead
  task. Nexus saves and chooses Leads, so they exist only while Nexus is enabled.
  Creating a workspace selects it so you can start a conversation with its Lead.
  The title or blank row area opens the workspace's Lead, or a task composer if
  it has none; sending from that composer makes the new task its Lead. Only the
  chevron expands or collapses
  the workspace. Hover Solo or a workspace and use **New task**, beside **…**, for another task. The button also appears with keyboard focus. **New task** is also in the workspace's **…** menu, the only place it shows when the header is too narrow, for example with enlarged text. Chat creation
  is available only in **Chats**. The workspace itself stays selected while its Lead
  conversation is open; the Lead has no separate task row. New task's agent picker
  lists agents eligible to run the task on this device.
  Without Nexus, chat creation remains available in the global **+** menu,
  Solo and each workspace; creating a workspace opens a chat draft filed there.
  Folders are optional unless **Work in a new worktree** is on. In that mode,
  add at least one project folder; the form shows a message beside Folders
  until you add one or turn worktree mode off. In **New chat**, typing **#**
  lists your workspaces above channels; choosing one sets the composer's
  workspace control and leaves no text in the message. A plugin's chat, such as
  a Nexus task, shows the workspace control when its plugin files it; until
  that chat's first message, **#** offers its workspaces too, and choosing one
  files the chat right away.
- **Channel links.** Type **#** and part of a channel name to link a channel.
  The link is a chip: Backspace or Delete removes it whole, so to change it,
  remove it and pick again with **#**.
- **Folder chips.** In the desktop app, type **!** and part of a folder name in
  any composer to list matching folders in this community's repositories folder
  (**Local settings**). Choosing one adds it to the message as a chip; the
  message shows the folder's name. When you send it to your own Claude or Codex
  agent on this device, the agent is told the folder's path, and Claude may also
  work in that folder for the rest of the conversation. A chip someone else
  sends, or a folder no longer in your repositories folder, grants nothing.
  A bare **!**, or **!** before a space, stays text.
- **Activity** (the bell at the top of the Messages sidebar) collects DMs, ordinary responses in Solo chats, mentions of you, and
  replies in threads you started, replied in, or follow. Solo chats appear under All, not DMs; their nested
  threads stay separate. Agent-only coordination stays out. The tabs (All, Threads, Mentions, DMs, Reactions) narrow it by
  kind, and **From** by sender (Anyone, People or Agents). Turn on **Unread** to see only what you haven't read:
  there, a row's ✓ marks it as read and it leaves the list, with **Undo** for a moment; when nothing is left it
  says **All caught up**. If loading fails, use **Retry activity** on the page or preview to retry; recovered
  activity clears the loading error.
  A DM row whose unread messages are all in one thread opens that thread; later DM messages outside it stay
  unread until you open the whole DM, which its row then does.
  **Reactions** shows recent reactions to your messages, with shared emoji grouped together per message and each person’s remaining emoji in their own row; selecting it turns Unread off.
  Reactions have no unread state or badge count. Clicking one opens your exact message in its conversation or thread.
  New reactions from updated clients appear; older unaddressed reactions are not backfilled.
  While Buzz is visible, a live reaction briefly replaces the Activity bell with its emoji for three seconds.
  Further reactions during that hold do not change the icon; history loading does not trigger it.
- **New messages** marks the first known unread incoming channel message when
  you enter. Once established, the divider stays in place for that visit as you
  read, reveal another message, or receive new messages. In a channel with more
  history than loads on entry, it appears when the oldest unread message is
  among the rows loaded on entry, below a message you read by reaching the
  bottom of the channel or marking the channel read. The same rule applies to
  a channel whose messages load as you enter it, such as the first time you
  open it after starting Buzz. When the unread messages
  start at the first loaded row or further up, or the messages above them were
  only read one by one as you scrolled past, there is no divider for that visit,
  even if older rows load later. While Buzz is still checking such a channel's
  older history for unread messages, the channel waits to mark anything read,
  so opening it then does not hide its own divider; if that check fails, there
  is no divider for that visit and reading resumes. The channel waits in the
  same way while it loads or refreshes the messages you entered on, however
  slow the connection; if that fails, reading resumes. It may also be absent when
  unread evidence is incomplete, or when
  read intent or the read evidence needed to locate the boundary changes
  elsewhere before it is established. If a visit has no divider and Buzz loses
  focus or is hidden while the channel stays open, messages that arrive
  meanwhile get a divider above the first of them when you come back, before
  anything is marked read; older unread messages, or a read elsewhere on this
  device while you were away, leave that visit without one.
- **Marking a channel read** keeps the cut from your click when retried. If a newer
  manual unread choice was saved in another window while it waited, the read fails
  rather than clearing that choice. Mark the channel read again to clear it.
- **Opening a channel or DM** while Buzz is visible and focused clears its sidebar row: the bold name, the mention
  dot and the thread dot. Switching away from Buzz pauses this: new messages
  can light the row even while that conversation stays selected. The macOS Dock dot follows the rows. Nothing is marked
  read: unread threads keep their dots in the conversation and in Activity →
  Threads, and **New messages** still marks where you left off. A mention, DM or
  reply to you that arrives after you leave lights the row again, as does any
  newer message; **Mark as unread** still shows on it. On another device, rows
  with unread mentions, DMs or replies to you light again until you read them.
- **Communities** have their own channels, people, and agents. Switch with
  the community switcher at the bottom of the dock; in **Personal space**,
  Messages offers **Choose a community**, which opens it. Switching
  communities changes the available context. A channel reopens where you
  stopped reading, or at the latest message once you had caught up. You and
  the person asking may have different channel access. A link alone never
  grants access.
- **Offline**: when Buzz can't reach a community, it shows the conversations
  saved on this device. Once Buzz reconnects, you can load messages older than
  those, and the top of the conversation says so.
- **Losing the connection**: Buzz keeps retrying on its own and says nothing
  for the first 30 seconds. If it still can't connect, a notice at the bottom
  right says "Buzz is having trouble connecting" until it reconnects. There is
  nothing to press.
- **Refused by a community**: if a community refuses your account, one
  notice at the bottom right says so on every page, with what fixes it. It
  doesn't retry on its own.
  - **Sign in to open this community**: your sign-in ended or expired.
    **Sign in with** that community's server. If Buzz still thinks you're
    signed in, **Sign in again** signs you out of that server and back in.
  - **This community needs a sign-in Buzz doesn't support yet**: this build
    can't sign in to that community. Ask its admin which Buzz version or
    server to use.
  - **You don't have access to this community**: when you're signed in through
    the community's server, it names the account it refused and offers
    **Switch account**. **Check again** once an admin has added you.
  - If the sidebar says the community refused your account, **Try again**
    asks again, so it works once an admin has fixed your access. Buzz never
    asks again on its own.
- **Finding channels**: search's **Channels** tab lists the community's open
  channels you can join, with their member counts; typing also matches channels
  you're in. Opening an unjoined channel shows a preview with **Join**. Private
  channels appear only once someone adds you. Search reopens where you left it
  for a few minutes; Escape starts fresh next time.
- **Jumping to unread**: opening search (⌘T or ⌘K; Ctrl elsewhere) with
  nothing typed lists up to six of your other unread channels and DMs first,
  most recently active first, and selects the first, so Enter opens it, instead
  of reopening where you left it. A conversation unread only through thread
  replies previews its newest unread reply and opens it in its thread. Muted
  conversations are left out. Turn this off with **Show unread first in
  search** in Settings → Appearance → Conversations.
- **Activity** threads name their channel above the original message. Select that
  name, or **Open in channel** in the thread tab's menu, to open the thread in
  Channels beside its original message, which the channel history shows and
  highlights.
- **Sidebar activity**: rest the pointer on a sidebar row to list its unread
  mentions of you and its unread threads, mentions first. Open one or mark it
  read from the list; just looking marks nothing read.
- **Mute** is available from a channel or DM's sidebar context menu. Once
  confirmed, a crossed-out bell appears immediately after its name. New messages
  do not make muted channel or DM names bold.
  Mute suppresses notifications for messages that do not mention you; mentions can still notify
  you. Unmute restores ordinary unread emphasis and dots. Manual **Mark as unread**
  can still make the name bold. Muted rows show no unread dots, including thread
  dots, and do not contribute to the sidebar’s floating **N unread** buttons or
  their avatar previews. Muted activity does not light the macOS Dock unread dot.
  Muting does not mark messages or threads as read.
- **Hidden DMs**: **Close conversation** and **Hide conversation** take a DM out
  of the sidebar without leaving it. To find one again, start a **New message**
  to exactly the same people. Its earlier messages appear before you send,
  without being marked read. Sending a message reopens the DM and brings it
  back to the sidebar. For a one-to-one DM, choosing the person in search is
  quicker and brings it back the same way. After **Hide conversation**, the row
  can take until the channel list next refreshes to return. If this connection
  can't start DMs, New message still shows the earlier messages but Send is
  disabled, and search opens a one-to-one DM without bringing it back.
- **Message link previews** appear when you hover or focus a Buzz message link.
  When the message can't be shown, the card says why: the channel is private,
  gone or in another community; the message isn't available, and may have
  been deleted; or the preview couldn't load. Links don't record their
  community, so one from another community looks like a private or missing
  channel. The card still opens the link.
- **Manage members** shows **General** access first in the member list. **Public**
  lets people in the community read and new people participate; **View only**
  lets them read; **Private** limits access to people added to the channel.
  Changing this choice does not change existing members' roles. Ordinary
  participants have no role caption; Owner, Admin, and Viewing only mark
  exceptions. Use a person's actions menu to change their role when permitted.
- **Message search** treats the last word you type as the start of a word, so
  it searches only once that word has at least three characters, even with
  `from:` or `in:`. A shorter last word shows how many characters to type, not
  "no results". Filters narrow it, alone or with text:
  - `from:me`, `from:@name`: messages by you or someone else.
  - `in:#channel`, `in:@person`: one channel, or your DM with someone
    (`in:@me` is your own). A name that matches several conversations, or
    none, says so instead of searching.
  - `after:`, `before:`, `on:` a date (`YYYY-MM-DD`, `today`, `yesterday`), and
    `during:` a day, month (`2026-10`, `october`), or year, in local time.
    `after:` includes its day; `before:` does not.
  - `"exact phrase"` and `-word` match whole words, not word starts. Anything
    inside quotes, `from:` or `-` included, is part of the phrase.
  Other words with a colon, such as `has:link`, are searched as text. An
  unfinished `from:` or `in:@` lists people, `in:` or `in:#` your channels,
  `after:`, `before:` or `during:` common dates, and `on:` a calendar; choose
  one to make it a chip. Click a chip to remove it, or press Backspace at the
  start of the text to edit the last one. With a filter, search shows only
  messages. Each message result's conversation name starts with the icon its
  channel header shows: a hash for a public channel, a lock for a private
  channel, or a chat bubble for a direct message or chat. Screen readers
  announce the type before the name.
- **Find on screen**: press ⌘⇧F (Ctrl+Shift+F on Windows and Linux) to find
  text already shown in the window, like a browser's find bar. Matches are
  highlighted, with the current one in orange, and the bar shows "n of total".
  Enter goes to the next match, Shift+Enter to the previous, and Escape closes
  it. With a dialog open, it searches that dialog. It doesn't find messages
  that haven't loaded or text in the message box; use ⌘F (**Search this
  conversation**) to search a conversation's full history.
- **Channel, people, and message search** shows “Searching…” beside each section heading
  if a lookup takes more than a second. You can open results already shown
  while the rest of the search finishes.
- **Search while offline**: while a community is offline or still connecting,
  search finds and opens the conversations saved on this device, and a line
  under the results says so. Messages, people and open channels are searched
  once it connects; while it is offline, **Retry connection** tries again.
- **Join** in a View only chat or channel adds you as a viewer, with a sidebar
  entry and normal unread tracking. Notifications follow your existing settings
  and mention/thread rules. You appear in People as **Viewing only**; you still
  cannot post, react, or change Canvas or Todos. Reading without joining
  stays available.
  Use **Leave chat** or **Leave channel** to remove your membership and sidebar
  entry. Joined viewers keep reading after a switch to Private until they leave
  or are removed in People.
- In a channel, typing `/leave` by itself opens the same **Leave channel**
  confirmation. The command is not posted as a message.
- Deleting the open Solo chat opens a neighboring Solo chat or a new draft while
  deletion finishes. The chat stays listed until deletion is confirmed. If it
  fails, a notice names the chat; you can reopen it from the sidebar.
- If **Delete chat** or **Delete channel** fails because relay requests are
  paused, nothing was deleted and the confirmation stays open. **Retry** becomes
  available when the pause ends; it checks your permission again before deleting.
  For an open Solo chat, the confirmation reappears over the new destination.
  **Cancel** keeps the chat; you can reopen it from the sidebar.
- **Pasted web links** keep their labels when the clipboard's HTML and plain
  text agree, including image alt text. Use ordinary paste; plain-text paste
  uses only the clipboard's plain text.
- **Long text pastes** that exceed the message limit show an error and leave
  your draft unchanged. Shorten the text, or save it as a text file and use
  **Attach files** where uploads are available.
- In the composer, Enter sends and Shift+Enter adds a new line by default.
  **Settings → Shortcuts → Sending messages → Send with ⌘ Enter** (Ctrl+Enter
  outside Apple platforms) swaps that on this device: Enter adds a line and
  ⌘/Ctrl+Enter sends. It starts off.
- If a message can't be sent, **Retry** appears under it right away. If its
  delivery is only unconfirmed, Buzz waits about ten seconds before saying so.
  To give up on it, choose **Delete message** in its "..." menu for a message
  that wasn't sent, or **Remove from this device** for an unconfirmed one. Both
  only stop this device from sending it; an unconfirmed message that did reach
  the relay stays in the conversation.
- A plugin can require a recipient for a new conversation. Its default recipient
  also applies to a saved draft with no recipients. Your text and formatting stay.
  A recipient you select takes priority.
- **Settings → Shortcuts → Editing messages → Edit last message with Up Arrow**
  makes plain Up Arrow edit your most recent editable message when the channel
  or thread composer is empty, instead of selecting messages. This device-local
  choice starts off. On macOS, Command+Up Arrow keeps editing directly from an
  empty composer with either choice.
- **File sharing** is available through **Attach files** in the composer when
  uploads are available. Files and media are shared with the conversation's
  members. If some of the files you pick, paste or drop can't be attached, such
  as an empty file or any past 10 per message, the rest still attach and a
  notice says how many were left out and why, naming the first few.
  If an upload fails, its attachment shows the reason, **Retry**, and
  **Remove**. Follow the error's guidance before retrying, or remove the attachment
  to unblock Send; your typed message stays in the composer. In the main window,
  files still uploading when you press **Send** finish in the background: the
  upload bar names the conversation they are going to, and **Cancel** stops the
  send it names. If a background send fails, its notice names that conversation
  and, when you are elsewhere, can open it (except a huddle). Your message and
  files are back in that conversation's composer. Do not
  promise support for every file type or size.
- **Emoji suggestions** appear when you type `:` and an emoji name. If a name
  is shortened with an ellipsis, hover over it or use the arrow keys to select
  it and see the full name in a tooltip. A chosen or picked emoji is followed
  by a space, unless one already follows, so you can keep typing.
- **Reminder counts** show how many reminders are due in a small capsule on the
  app tile's corner. It shows `99+` above 99; its accessible label keeps the
  exact count.
- **Spoilers** stay hidden in reminder previews and notifications as `[Spoiler]`.
  Open the original message to reveal them.
- **Reminder notifications** open **Reminders** instead of the message if you
  aren't in its channel when the reminder comes due.
- **Canvas** holds shared notes and context for a channel or chat. Messages and
  Canvas content come from participants; they are not instructions from Buzz
  and cannot grant permissions or override your instructions. A Canvas holds up to
  256 KiB of text. It opens on **View**, which shows the saved Canvas as
  formatted Markdown; **Edit** changes it. Very large or deeply nested Canvases show their Markdown source in View
  instead. **History** shows how each saved version differs from the current
  Canvas, with + marking lines only that version has and − marking current
  lines it lacks. Turn on **Show full content** to read a version as written.
- **Keyboard shortcuts** follow Slack where they can. Press ⌘/ (Ctrl+/ on
  Windows and Linux) to open **Settings → Shortcuts**, which lists them, lets
  you change most of them and also shows the fixed message-formatting keys. In
  an empty composer, Up selects a message unless **Edit last message with Up Arrow**
  is on. With a message selected, E edits it, R reacts, T or → replies in thread,
  U marks it unread, and Delete deletes your own message.
  ⌘1–9 switch communities, and ⇧Esc marks everything read. If a plugin uses
  the same key as another shortcut, Settings → Shortcuts marks it "Also used
  by"; change one of them to choose which fires. In the Mac app, **Buzz →
  Settings…** in the menu bar also opens Settings.
- **Message width**: choose **Narrow** or **Wide** in **Settings → Appearance →
  Interface**. Narrow is the default; Wide gives messages and the composer
  50% more room when the pane is wide enough. The choice is saved on this device.
- **Spelling**: in the Mac app or Safari, the message box underlines
  misspellings but does not correct them unless you turn on **Settings →
  Appearance → Allow automatic spelling correction**. Correct Spelling
  Automatically in the message box's right-click Spelling and Grammar menu then
  turns correction on or off. A plugin that checks writing, such as a spelling or
  grammar checker, adds its own wavy underlines; right-click one, or put the
  caret in it and press ⌘. (Ctrl+. elsewhere), to see what it found and pick a
  replacement. ⌘Z undoes the change.
- **Message density**: **Settings → Appearance → Message density → Compact**
  shows conversations, including threads, as a flat, left-aligned list without
  bubbles, across the window's full width, to fit more on screen. Hover or focus
  a row to show its timestamp; grouped messages show it in the left gutter.
  Text size stays with **Interface size**.
  Hover a row to highlight it and show message actions at the right
  edge. The choice applies on this device only.
- **Time format**: **Settings → Appearance → Clock** chooses 12-hour or
  24-hour times. System, the default, follows the desktop app's operating
  system: the 24-hour time setting on macOS, the short time format on Windows,
  and on Linux GNOME's time format or else the `LC_TIME` locale. In a browser it
  follows the language and region. Show seconds adds seconds to clock times. **Message timestamps** can hide the
  time beside each message everywhere or only in Solo chats; day dividers and
  screen-reader dates remain.
- **Back and Forward**: after following a channel or message link to another
  channel, Back and Forward restore the thread tab you last selected in the
  channel you left.
  In the macOS app, mouse back/forward buttons and
  three-finger trackpad swipes go back and forward like the ← → arrows in the
  header. Swipes need System Settings → Trackpad → More Gestures → Swipe
  between pages set to three fingers (or two or three fingers). Two-finger
  scrolling does not navigate.
- **Closing the window** in the macOS app hides it; Buzz and its agents keep
  running. Switching back to Buzz, for example with ⌘Tab or its Dock icon,
  shows it again. A minimized window stays in the Dock. ⌘Q quits.
- **Sharing a Solo chat** grants access to its conversation history, not only
  the next message. Search for a channel in its access dialog and click **Share**
  beside the result. This makes a Private chat **View only** and posts a link
  there, after confirming community
  access to the full history and Canvas. Chats already set to View only get a
  delivery confirmation and keep their access. Public chats post directly.
  The success toast confirms any change to View only and offers **View** to open
  the posted link in the destination channel.
  Opening a shared chat link creates no sidebar entry.
  Direct invitations still add members. Pasting a link to a Private chat you own into a channel, thread or DM
  uses the same confirmation, then sends your original message. Owned View only
  chat links also confirm delivery. Other chat links send without changing access;
  recipients still need permission to read.
  If an owned chat's access or details change during confirmation, review the
  refreshed consent and choose **Share** again before sending.
  The access dialog offers **View only** for community reading
  or **Private** for people added to the chat. Public is not offered in
  this UI; a Public policy set through another client appears as
  **Public (existing)**. This is not protocol enforcement. View-only visitors
  cannot post; existing members keep their roles. Returning to Private warns
  about retained viewers unless verified roles show no Guests, including while
  roles load or fail to load; remove them in People to end their access. Public
  (existing) → Private also warns that joined members retain their access.
  Manually changing Public (existing) to View only confirms that existing
  members keep their access. Agents the owner adds through
  access search or a composer mention receive Bot access so they can reply,
  including with a Guest admission default. Conversion to a channel offers
  Private, View only and Public, starts from the chat's current access, and saves
  the selected policy. Choosing Private during conversion also warns that people
  who joined keep their access until removed in People. Opening a private chat to the community warns that its full
  history and Canvas, including workspace folders and agent instructions, become
  readable. View only retains Guest admission. Copying its link alone does not grant access. Check the intended people
  and destination before changing access. If an older saved invitation granted
  view-only access, remove that person in People and invite them again for
  participation. For an older unresolved invitation, use **Retry** in Outbox
  or add the person again if the receipt is already Seen. After its 15-minute
  delivery window, Buzz verifies the original command and current membership
  before allowing a fresh participation invitation; failed checks keep the original.
  If the original invitation was applied and the person was later removed, Retry
  clears the old row without re-adding them. Use **Add** in People to invite them again.
- **Open links in your browser**: on desktop, ⌘-click (Ctrl-click on Windows
  and Linux) an HTTP(S) link in a message to open it in your default browser
  instead of a side panel. You can also right-click the link and choose
  **Open in browser**.
- **Conversations in plugin pages**: a plugin can show a conversation as its
  main view, with the normal message controls and a panel on the right. Its
  header actions come from the plugin. Closing a side tab keeps the main view.
  Plugins can also make their panels available as conversation detail links.
  Back and Forward restore these visits. Close retires the closed panel's visits.
- **Close tabs or the window (macOS)**: ⌘W closes the active tab. With no tab
  to close, it closes the window while Buzz and running agents stay open.
  Reopen Buzz from the Dock. ⌘⇧W clears the current channel's tabs without
  closing the window. These tab shortcuts do nothing while a modal is open.
- **Conversation members**: click the combined member avatars and conversation
  name in the header to open membership management. Other header actions remain
  on the right. Compact avatars sit before the name on the left; Solo chats show
  the included agents.
- **App navigation**: use the left dock to switch apps. Bestie is first,
  followed by Messages and the other apps. Activity is the first row of the
  Messages sidebar. Community and profile controls
  sit at the bottom of the dock. Search stays wide in the top bar.
  Messages has All / Solo / Team sidebar filters; other apps use their main
  view unless they provide their own sidebar. Pages listed in the Messages
  sidebar, such as the Drafts & sent plugin, keep Messages selected in the dock. The
  Messages sidebar stays open unless the page provides its own sidebar, which
  replaces it.
  The sidebar and message pane share one surface with a persistent divider;
  panel headers also have bottom hairlines. Dock icons stay still, highlight
  on hover, and show instant labels to their right. Bestie uses your
  configured avatar.
  The **+** opens New from the sidebar. **Cmd/Ctrl+N** opens that menu where
  the current app has a creation sidebar.
- **Link boundaries**: a bare http(s) or buzz link ends at whitespace and at
  fullwidth, CJK or curly-quote punctuation such as `，`, `。`, `」` or `’`. In a
  host name, `。` works as a dot. Wrap it as `<url>` to keep them in it.
- **Approving a Builderlab tool app**: the first time a tool app asks for
  approval, Buzz opens the approval page in your default browser, where you
  are signed in to Builderlab. Approve it there and return to Buzz; the app
  reloads on its own. **Reload** also opens it.
- **Connecting an account in a Builderlab app**: when an app asks to connect
  an account such as GitHub or Linear, Buzz opens the Builderlab connections
  page in your default browser. Connect it there and return to Buzz; the app
  reloads. Buzz opens one such page by itself until you next click Back,
  Forward or Reload or use the address bar; if the app asks again, click
  **Open in browser** in the bar above it.
- **Drafts & sent** is an optional plugin, off by default. Turn it on in
  **Settings → Plugins**, and it appears in the Messages sidebar. Opening it keeps
  the conversation sidebar available, so you can switch straight back to a chat.
  Saved links to it open the plugin, or offer to turn it on. Use the **Drafts**
  and **Sent** tabs to switch lists; Buzz remembers your choice for this community.
  Rows lead with the destination and message text. It lists
  the messages you started but did not send, newest
  change first, with the number of drafts shown beside it in the Messages
  sidebar, and your latest 100 sent messages in this community, grouped by
  day. A sent message shows who replied after you ("2 after you") or that you
  were last ("You're last"); a channel post shows its reply count. Select a
  draft to edit and send in a conversation preview beside the list; **Open
  conversation** opens its original destination. Narrow windows show the preview
  with **Back to drafts**. After confirmed delivery the preview closes; failed
  sends stay in its message history with Retry. Select a sent message to preview
  it in context and reply in place; Sent previews stay open after sending. Both
  previews use the conversation’s saved draft, if one exists. Archived or read-only
  Sent destinations show the conversation without a composer, with an archived
  or read-only notice and Join when available. The popout icon
  opens the original conversation.
  Search above the list matches the conversation name and what you wrote. It reads only this
  device's saved drafts; a draft's trash button clears that draft and its
  attached files without opening the conversation. A thread draft also shows
  where you left it: **Draft** on a message's reply line, or **Draft reply** when
  no one has replied yet (hidden while that thread is open).
- **Changesets** is an optional desktop plugin, off by default. When a local
  agent finishes a turn in a chat with project folders, a card under its last
  message lists the files it changed, with added and removed lines. Only you
  see it. Choose a file to open its diff beside the chat. It skips agents on
  other computers and remote agents, and keeps the latest 300 turns on this
  device.
- **Activity preview**: with a mouse or trackpad, rest the pointer on
  **Activity** in the Messages sidebar to see recent mentions, DMs, thread replies, and reactions
  without opening the Activity page. Clicking a conversation opens it directly;
  **Open Activity** opens the page. The card's **Unread only** switch is
  separate from the Activity page's filters and hides reactions when on. The preview is not shown on touch
  devices or while the Activity page is open.
- **Live message alerts** still follow your notification settings when a channel
  read loads the message before its live delivery arrives. Loading history alone
  does not send alerts.
- **Sidebar width**: drag the sidebar's right edge, or focus its resize handle
  and use the Left/Right arrow keys. Double-click the handle to reset the width.
  Messages and plugin pages share the saved width within the same community
  and identity; narrow windows use a navigation drawer instead.
- **Sidebar sections**: in **All**, use the arrow beside **Solo** or **Team** to
  collapse either section independently. Buzz remembers the collapsed sections
  for that community and identity. Collapsed section headings highlight when
  their channels have unread messages or thread replies. Muted channels do not
  highlight the heading.
- Saved sidebar groups, stars, mutes, sorting and filters from another device or
  a paired CLI update the open sidebar automatically while connected, in hosts
  that support saved sidebar preferences. A CLI section-only move keeps a
  starred channel in Starred until you unstar it.
- **Plugin channel rows**: a plugin can open a channel from its Solo row and keep
  that row selected. The sidebar then keeps its scope, scroll position, and open
  sections. When a plugin is explicitly disabled, its existing chats appear as
  ordinary Solo chats; enabling it again returns them to the plugin's rows when
  available. Opening the channel from Team follows the usual Team navigation.
- **Side panels stay with their conversation**: a tab or panel you open beside a
  conversation, such as a thread, **Canvas**, a huddle, or Todos, stays open for
  that conversation when you go to another conversation or page and come back,
  until you close it. Reloading Buzz does not restore it. The Terminal drawer
  closes when you leave the conversation.
- **Renamed thread tabs**: a name you or an agent give a thread tab is saved on
  this device for the account and community until the tab is closed. The
  thread's tab shows it again when it reopens after switching channels,
  quitting or updating Buzz. Closing the tab or clearing the name restores the
  automatic title. Buzz keeps the 256 most recently renamed threads per account
  and community.
- **Panel dividers**: the divider between a page and its side panel (such as
  the Activity list and a conversation) works the same way. Each page remembers
  its own width within the same community and identity; double-click to reset.

## Saved Solo follow-ups

Messages queued behind a working agent are saved on this device for the current
account and community. Saved text, recipients, uploaded attachments, references,
and model choices survive a reload or restart; uploads still in progress are not
queued yet.

Use the pencil button to edit queued text in the message composer. Save changes
or cancel to return to your previous draft; attachments and recipients stay with
the queued message. The X button removes it, and the up-arrow sends it.

After restart, saved messages stay paused. **Send** sends a selected row, and
**Remove** discards an unsent row. **Resume** restarts supported interrupted turns
and unpauses saved follow-ups in those chats, sending them in order as turns finish.
**Don’t resume** leaves them paused. Chats outside that recovery stay paused too.

If another window may be sending a message, check the conversation before sending
again. Remove is unavailable once delivery owns the message; use its delivery
recovery controls instead. A save or recovery error keeps the draft or queued row
available rather than silently discarding it.

## Choosing and customizing agents

- An optional plugin can attach context to a native session. Follow-ups and
  reconnects keep that association. **New** starts another association. Each
  agent keeps its current conversation, reply placement and session controls.

- Open an agent’s **Memory** tab and expand a memory to read it with Markdown
  formatting, including headings, lists, code, tables, and line breaks. Memory
  images stay as text rather than loading remote content. **Copy full body** in
  a memory’s context menu copies its original Markdown.
  Buzz links use the app’s link labels and previews and open their destination
  in the same community. Links inside code stay as text.

- Buzz supports different agent types, including Claude, Codex, Goose, and Pi.
  A **harness** is the software that runs an agent; a **model** is the AI it
  uses. Available types and models depend on the platform, active plugins, and
  provider setup. Tools and connections depend on that agent's configuration;
  naming a service or adding instructions does not connect it.
- On desktop, Buzz starts every agent with `BUZZ_VERSION` set to the app's
  version, and agents usually pass it on to the shell commands they run. A
  script or shell config can check for it to tell it is running under Buzz.
- In communities where your build restricts workflows, workflow messages do
  not automatically start or steer local Claude, Codex, Goose, or Pi agents. To
  have one act on a workflow result, send it a direct request explaining what
  to do with that result. Other communities still let a workflow you or your
  agents created mention your agents.
- **Agents** is where people create and manage agents. For supported types,
  open an agent there and use **Identity → Instructions**. Opening its avatar or
  name in a conversation shows its profile, where **Settings → Instructions**
  offers the same edit. Model, workspace, and other runtime options depend on
  its type. Where offered, **Create agent** also lets people choose Thinking
  before the first config is saved; **Default** follows the provider's setting.
  Do not assume someone can edit another person's agent.
- In the agent avatar picker, drag the avatar strip with a mouse or scroll it
  to browse more choices. Click an avatar to select it; keyboard users can Tab
  through the choices and press Enter or Space.
- For agents running on this computer, **Identity** normally holds Harness,
  Model, Thinking, and Instructions. **Settings** holds Workspace,
  **Sessions** (called **Conversations** for Pi), configuration history, and
  removal or deletion controls. **Memory** and **Activity** have their own tabs
  when available; plugins can add tabs such as **Attention** or **Bestie**.
  Hosted agents and agents on another device expose only the controls this
  device and their provider support.
- For supported local agents, **One session per thread** keeps each channel
  thread's context separate. **One session per channel** lets threads in the
  same channel share context. This setting changes what the agent remembers
  together, not where its reply appears. A DM, huddle room, or Solo chat is one
  continuing conversation under either choice.
- A desktop plugin can run native Codex or Claude on another computer. The plugin manages the target, workspace, credentials, and expiry. A saved
  remote choice stays remote after an app restart. If the target cannot be
  restored, Buzz shows an error and requires a new session.
  The model control on a remote agent card opens that agent's Settings. In update
  reviews, its Thinking choice is read-only rather than using this computer's options.
  Remote Claude uses the Claude sign-in on the target. It keeps each saved
  conversation in that target's workspace. Stop ends its active turn.
  Remote Claude usage totals and transcripts are unavailable.

### Builderlab accounts and remote agents

- Builderlab uses one account and sign-in for the communities and agents it
  hosts. **Create account** or **Sign in** during Buzz setup can link and back up
  this device's Buzz key, but a Builderlab account, a Buzz identity, community
  membership, and an agent are still separate things. Signing in alone does not
  join a community or create an agent. **Settings → Plugins → Builderlab** shows
  the connected account and its hosted communities and agents; **Manage account**
  opens **Settings → Buzz → Identity**, where **Community sign-ins** manages the
  shared Builderlab session.
- For the quickest first-agent path, open the pinned **Create an agent**
  destination, choose **Create an agent**, then select **Builderlab** under
  **Remote** in the Harness menu. Sign in, add a name, choose Model and Thinking,
  and create the agent. After its introduction, Buzz asks you to confirm it as
  your remote Bestie, then opens your pinned DM. Creating one from **Agents → New
  agent** uses the same form without choosing a Bestie; use **Make my bestie**
  afterward if you want it pinned.
- When creating a Builderlab agent, choose a model from its family menu,
  then choose a supported **Thinking** level. If Builderlab recommends a model
  and thinking level, both start selected; change either to choose your own. Both
  choices are required; changing the model clears the thinking choice.
  A bolt after a model's name means Builderlab serves it on faster hardware, so
  it replies sooner. When only some models are fast, the menu also lists them
  in a **Fast** section at the top, above the families.
  Instructions are optional. **Create agent** stays disabled until its name and
  required choices are complete; Builderlab also waits for sign-in and its model
  catalog.
  A Builderlab agent runs on your Builderlab account; the creation form links
  that Builderlab server's site, where the account's usage and billing are.
  The **Remote agent** hint in a signed-in Builderlab agent's **Identity** tab
  also links to **See usage and billing** on that site.
- Builderlab sign-in is needed to create or delete a hosted agent and to edit its
  model or instructions. Sign in to the same Builderlab account that created the
  agent; another account cannot manage it. Chat, Memory, and Activity use the
  Buzz community connection instead, so messaging can still work while
  Builderlab is signed out. On a phone, sign in with the same Builderlab account;
  when that account holds this Buzz identity's backup, Buzz restores it instead
  of asking for QR pairing. The remote agent can answer while the desktop is off,
  but it cannot open files on that desktop.
- Desktop's **Harness** menu groups agent types under **Remote** and **Local**.
  Creating a remote agent on desktop opens an introduction with its chosen name
  and avatar, explaining its online workspace and file access (Builderlab
  includes its name and logo). The text streams in, or appears immediately with reduced motion;
  choose **Let’s go** to create it, or **Back** to keep editing. The introduction
  stays visible while creation runs; if creation fails, retry there or go Back
  to edit the retained draft.
  When signed out of Builderlab, use **Sign in** beside Harness first.
  Model, Thinking and Create agent stay disabled until sign-in completes.
  During browser sign-in, click the loading spinner to cancel. Account verification
  cannot be cancelled.
  Opening an existing Builderlab agent’s **Identity** automatically attempts
  sign-in if needed. The compact action beside Harness shows a clickable loading
  spinner that cancels browser sign-in. Cancelled, timed-out or failed attempts
  wait for you to retry there. A signed-out hint explains that messaging still works
  and sign-in enables editing. Model and Thinking stay disabled, and
  Instructions appear after sign-in. Sheets appear for settings or account-access
  errors. If the agent cannot be found, **Retry** reloads it without signing you out.
  Native account-access errors open **Identity → Organization sign-in** without
  ending the shared session. In live development, **Use another account** ends
  the broker sign-in and opens its browser logout page. After signing in with
  another account in the browser, return to Buzz and click **Retry** beside
  Harness. A spinner appears for three seconds before Retry becomes available;
  click it to end the wait early.
  Chat, Memory and Activity use your Buzz community connection and do not require this Builderlab sign-in.
  Builderlab agents work from your phone even when your desktop is off, and
  cannot open files on your computer. Their Settings hint appears only while
  signed in, beside a cloud. Local agents have no execution hint.
  Workspace in Settings also explains that the runtime is shared with your
  other agents in the workspace by default.
  Cards and pane headings omit location captions. Both @ menus identify known
  remote agents with **Remote**, alongside membership details. Local rows have
  no location caption. The Harness menu keeps the Remote and Local group headings.
  Owners also see **Remote** beside their agents’ names in messages and typing or
  working previews when the local inventory confirms remote execution. Hover or
  focus it for where the agent runs. A cloud precedes a remote agent’s current
  step and pulses while working, staying still with reduced motion.
  When a remote agent has no current step details, the activity popover shows
  where it runs; received tool details take precedence.
  Available model, effort and session controls keep their gauge beside Send.
  Activity keeps its transcript and feed guidance without a separate workspace
  note. Opened from a conversation, it shows that conversation's turns;
  **Show all conversations** lists the agent's other turns too. It shows only
  turns captured while Buzz has been open.
- Plugin requests show local work status even when they have no message.
  A failed request offers Retry. View opens its thread or conversation.
- **Online badge on Builderlab agents**: a Builderlab-hosted agent's avatar
  shows the green Online badge to everyone in the community while its owner
  has set it up on a remote runtime and has not deleted it. The badge means the
  agent is configured to run remotely and wakes when mentioned; it does not
  prove the runtime is up right now, and a working indicator still shows actual
  work. Deleting the agent clears the badge for other viewers within a few
  minutes. Agents that run on someone's computer, and people, keep their badge
  from recent Buzz activity, so a local agent goes grey when its owner's Buzz
  is closed.
- A shared agent image in a desktop conversation shows **Add agent** beneath
  its name. Choose it to review and import the agent; the preview omits the model.
- An agent card link, `buzz://agent/new?card=<id>` (a Builderlab card's
  **Add to Buzz**), opens **Create agent** filled in with the card's name,
  picture and instructions, on desktop and mobile. Nothing is created until you
  review it and choose **Create agent**. Choose the harness and model yourself;
  instructions go to harnesses that keep them. On desktop, a Builderlab card's
  share link in a message shows the agent's picture and name; hovering it
  offers **Add to Buzz**, which opens that same Create agent. Clicking the link
  still opens its page.
- An agent's name and picture identify it. Instructions shape its response
  style, tasks, initiative, and boundaries. They do not add tools, credentials,
  or permissions. Saving instructions affects future work, not past messages.
  Never say changes were saved until Save succeeds.
- Claude Code's open settings follow saved changes to fields you haven't edited.
  Your unsaved edits stay in the form. If the same setting changed elsewhere,
  review the values beside that setting, then choose **Use latest** or **Keep mine**
  before saving. Use **View latest instructions** to read competing instructions.
  Model and thinking are resolved together. If Save reports an error, some settings
  may already have saved; the remaining edits stay available to retry.
  If configuration is unavailable, edits stay in the open form, but saving
  (including Workspace changes) waits until configuration returns.
- A **Bestie** is an existing agent chosen as someone's personal default, not a
  separate agent type. **Make my bestie** in an agent card's menu saves that
  choice to the account and initially tags the agent in new Solo chats for that
  community. A star and Bestie label in the top-left of its desktop card mark the
  saved Bestie. It does not replace recipients in an existing chat or edited
  draft, and people can choose another agent for any conversation. Bestie status
  by itself does not add tools, private-channel access, permissions, or guaranteed
  availability, and does not prove the agent is ready or running. The settings
  below can deliberately add memory guidance, channel membership, and check-ins.
- When the optional **Bestie** plugin is on, the saved choice also opens the
  agent's DM from the first position in the left Apps dock, using the agent's
  name and avatar. The Messages sidebar omits the duplicate Bestie row. Bestie
  uses the same conversation tabs as Messages: threads open beside the chat (or
  in the main pane, following your thread placement setting), and can be moved,
  renamed, or closed. Collapsing the side pane keeps its open threads and reply
  drafts. Its header includes the same DM controls and actions, including Huddle
  when supported and enabled. On the Bestie page, ⌘F (Ctrl+F elsewhere)
  searches the Bestie conversation, and ⌘K (Ctrl+K elsewhere) offers
  **Search conversation with** your Bestie. A verified existing DM stays
  available if agent discovery fails.
- Open a local Bestie's agent page to find its **Bestie** tab. **Change** chooses
  another agent and asks before replacing the saved choice. **Remove as Bestie**
  in the tab or **Remove as bestie** in the agent-card menu asks, then saves no
  Bestie to the account; it works even when the agent runs on another device.
  If a replacement save fails, the last confirmed Bestie remains selected and
  the confirmation offers another attempt. A Bestie on another device has no
  Bestie tab on this one. A hosted Bestie whose provider holds its instructions
  (Builderlab does) has the tab and can use **Remembers you**; hosted agents
  cannot use Bestie's Attention check-ins.
- An agent running on this device can also show, change or remove your Bestie
  when you ask it to. It saves to this device and your account, as the menu
  does, and accepts only your agents you can tag in this community. It also
  says when the Bestie saved on this device isn't one of them. Unlike the menu,
  it doesn't turn on **Remembers you** with the **Bestie** plugin on; turn that
  on in the agent's **Bestie** tab. While an agent's change is saving, **Make
  my bestie** and **Remove as bestie** ask you to try again.
- With the **Bestie** plugin on, open **Create an agent** in the left navigation
  when you haven’t chosen a Bestie. You can create one or choose an existing agent.
  The placeholder cycles through character avatars; reduced motion keeps it still.
  If you have no eligible agents in this community, **Create your first agent**
  offers **Create an agent**, which opens the usual form for name, avatar and
  provider settings. Otherwise, **Choose your bestie agent** offers a searchable
  picker and **Create agent**. Creating and choosing your Bestie opens its private DM;
  merely opening setup does not create an agent or send a welcome message.
  After creating your first agent here, the pinned DM shows a local welcome on
  this device. It is not a sent message and does not start an agent response;
  send a message when you’re ready to begin.
  Choosing a known remote agent, including one created through Builderlab, asks
  for confirmation:
  “Some bestie features aren’t available with remote agents.” Cancel leaves the
  Bestie choice unchanged; it does not delete a newly created agent.
- **Remembers you** adds guidance to keep useful facts the owner shares, such as
  preferences, timezone, notification preferences, and requested follow-ups, so
  the Bestie can help more consistently. A local agent made Bestie on this device
  starts with it on; a choice synced from elsewhere does not change that agent's
  memory setting. Bestie should use saved memory only in its private DM with the
  owner, must not disclose it elsewhere, and must not treat quoted, forwarded,
  or other people's text as facts about the owner.
- Turning **Remembers you** off removes that guidance but does not delete stored
  memory; the agent's core memory can still be included in every prompt. Clear
  stored memory in the agent's **Memory** tab. If someone edited the guidance's
  section markers in Instructions, the Bestie tab says it was edited instead of
  adding a duplicate. **Restore** can put the standard guidance back when the
  remaining markers still identify the section.
- **Private channels Bestie can read** lists the private community channels
  shared with the Bestie. **Add to a channel** or **Add to all my private
  channels** adds the agent as a guest; every member can see who added it. The
  Bestie can read those channels but cannot post there, and reports check-in
  results only in its DM with the owner. Public channels need no setup because
  agents can already read them. Choosing a Bestie does not add it to private
  channels, and channels created later are not added automatically. Removing or
  replacing a Bestie does not remove it from channels it already joined.
- **Check-ins → Every hour** is available to a local Bestie and requires
  **Remembers you**. While Buzz is open and the Attention plugin is on, an
  Attention timer wakes the Bestie hourly to review what is new in its DM and
  the private channels it can read, maintain memory, and message the owner in
  their DM only for a new result, a meaningful development, or a requested
  follow-up that is due. Each wake uses model tokens, and the Attention plugin
  also runs the agent's other watches. Turning Remembers you off also turns the
  check-in off.
- Only the current Bestie checks in. Replacing or removing it stops its check-ins
  after this device reads the saved account choice, but leaves its memory
  guidance, stored memory, and private-channel memberships in place. A local or
  supported hosted agent keeps a **Former Bestie** tab while its Bestie
  instruction section or a private-channel membership remains; use it to turn
  memory off, remove the agent from private channels, or make it the Bestie
  again.
- **Delete** on an agent's page stops it, takes it out of its channels, archives
  it in its community so nothing offers it again (pickers, mentions, New
  message, Forward, Search, member search, templates), then deletes it. Its key
  stays until the archive is confirmed. If its profile doesn't name you as its
  owner, Buzz republishes its profile naming you as its owner first. If any step fails,
  Delete says it didn't finish: the agent stays stopped and keeps its key, and
  **Delete** again finishes it. For a hosted agent, Buzz archives it before its
  provider removes it; if the archive fails, nothing changes. If the provider
  then fails, the agent may still be running: delete it again. A hosted agent
  whose profile doesn't name you as its owner can't be archived, so Delete says
  why and stops. In a community that advertises no archive authority, Delete
  skips the archive. **Forget** drops an agent that can't reach its community
  from this device only; it may stay in that community's channels.
- **Settings → Agent setup → Harness defaults** is where supported agent types
  offer installation, sign-in, and default-model controls. Available controls
  depend on the type. Do not assume a provider is configured or signed in.
  Builderlab shows **Unavailable for this account** when signed in without
  remote-agent access. Manage its account in **Settings → Builderlab**.
  Builderlab permissions are re-read at most once a minute while the app uses
  them, so a newly granted or removed permission applies without signing in
  again; a failed check keeps the previous permissions.
  Claude runs with an Anthropic API key pasted under **Anthropic API key**
  there, once for every local Claude agent. With the Claude plugin enabled,
  **Settings → Claude → Set** opens **Connect Claude** to add a key. Back hides
  setup and Forward restores its draft while the Claude page remains open.
  The input keeps focus but is read-only while secure storage is checked. If the
  check fails, the dialog keeps its draft and offers **Retry**; saving waits for
  a successful check. Closing the dialog discards its draft; saving returns to
  the masked, read-only saved key. The field opens its **Replace / Remove** menu
  when focused or clicked; the chevron also opens it. **Replace** opens a blank,
  masked field with small **Cancel / Save** buttons inside it. When adding or replacing a key, **Save**
  stays visible inside the field and is disabled until you enter a key.
  **Save** stores a non-empty replacement
  and returns to the masked view; **Cancel** discards the draft. Settings cannot
  reveal or copy the saved key. The small inline **Save** stays visible and is
  disabled until you enter a key; **Cancel** stays available during replacement.
  Leaving the page discards the replacement draft.
  **Remove** deletes the saved key from this device’s secure storage after
  confirmation. Key actions are unavailable while replacing the key.
  You can also add or remove a key
  if the Claude integration needs installation or an update. New local Claude sessions and security
  reviews need a key again; a turn already running can finish.
  When creating a Claude agent or editing
  one that runs on this computer, click **Add key** beside **Harness** to open
  **Set up Claude**. Builds with interactive authentication show **Sign in**
  instead. Selecting Claude does not open setup automatically; closing setup
  keeps Claude selected. An interactive sign-in continues if you navigate Back;
  returning to creation restores its pending controls with **Cancel**, without
  starting another sign-in. Explicitly closing setup cancels a pending sign-in.
  **Model**, **Thinking**, and agent creation wait until credentials are saved.
  Agents on execution targets use that target's credentials, not a key on this
  computer. Buzz keeps the API key in the system's secure credential store
  (Keychain on macOS) and
  gives it to every Claude process, security reviews included. Commands a
  Claude agent runs inherit it, so they can read the key. Until a key is
  saved, Claude agents don't answer and Claude reviews fail closed.
  Codex security reviews for protected agents need a ChatGPT sign-in made
  there, and fail until there is one, or while Codex's sign-in is for another
  workspace. Codex's harness defaults offer that sign-in while Codex is signed
  out. API key and keyring sign-ins can't run them.
- **Settings → Agent details** says where an agent's configuration lives:
  **Synced in** its community, or **Only on this Mac** with why (the relay
  doesn't sync agent settings, or the first copy failed and Buzz will try
  again). Hosted agents show no line. Editing a team shows the same line for
  the team. Teams made before teams synced move to their agents' community
  automatically once it syncs teams; a team whose agents are in different
  communities stays on this Mac.
- Each Claude agent running on this computer keeps its own `claude` process for
  each active conversation. While an unprotected one runs here, Buzz also keeps
  one shared process ready for the next new conversation. Each of these starts
  its own copies of the local MCP servers in your Claude Code configuration, so
  memory use grows with active conversations times those servers. A
  conversation's process stops after 15 minutes with no message, turn or
  background work. Protected agents load none of your MCP servers and don't use
  the shared process. To lower the cost, remove servers agents don't need, or
  move heavy servers from user scope to local or project scope in the folders
  where you use them. Agents work in their **Workspace** folder (`~/.buzz` by
  default), so keep those servers out of that folder, the folders above it,
  and any Git repository it is in.
- **Settings → Agent details → Previous versions** expands saved revisions for
  agents whose configuration syncs here. Settings and instructions appear together
  in one feed, newest first, with a label on each version. Versions are kept
  automatically when changes are saved. Click a version to open
  its changes in a dialog; older valid versions offer **Revert to this** (or
  **Restore this** after deletion). An accent dot marks the current version in
  the feed; the dialog identifies it in words and offers no restore action.
  **Load older** fetches more history. Reverting one track saves
  a new revision without changing the other track.
- **Agents → Your teams → Previous versions**, in a team's editor, lists the
  saved versions of a team that syncs to a community, the same way. Reverting
  restores its instructions and keeps its current name; members are not
  versioned. Teams kept only on this Mac have no versions.
- Your agents can read your agents and teams here (`agent_read`,
  `team_read`) and propose a team's new name or instructions
  (`team_update`). A proposal opens a review: nothing changes until you save
  it, members never change this way, and Save is refused if the team changed
  since the proposal.
- **Activity**, where the agent type provides it, shows sessions and their
  transcripts in the agent's profile. An open transcript updates by itself
  while the agent works; **Refresh transcript** stays at the top as you scroll.
  A turn's **Thread** or **Channel** label
  opens that conversation. Choosing an agent in the activity under a message,
  or a Working now agent whose conversation is known, opens that
  conversation's transcript. Working indicators describe current work,
  not a guarantee that an agent is available or that a message was delivered.
  Local work includes conversation wakes from plugins, watches, and timers.
  These wakes have no message link of their own.
  Expand grouped work updates to read each message; the collapsed excerpt names
  its speaker. Thread work appears inside its thread; the channel’s reply summary
  still shows when an agent is working there. While the activity under your
  message shows an agent working, it is that agent's only working indicator.
  Once its recorded updates show that work, they carry the dots instead, until
  a newer message arrives below them.
  Otherwise dots remain at the end of the conversation while agents work,
  alongside current step details when available. With Reduce Motion enabled,
  the dots stay still. For one agent, click the live activity bubble to open
  its activity; hover or focus the bubble to reveal **Stop** (always visible on
  touch screens). For several agents, open or hover the bubble to choose an
  agent’s activity or stop an individual request. Expand recorded work for its
  activity controls. Stop availability
  depends on the agent type.
  For native Claude, Codex and Goose, Stop also cancels pending plugin tool calls
  that use the host signal. It cannot undo a write already sent.
- Agent-to-agent messages stay in the conversation as collapsed history after
  work finishes or you reopen a thread. Expand them to read dispatches, handoffs,
  and results. The working indicator shows current activity separately.
  If more updates arrive after a reply, the newest update group carries that
  agent’s live activity and Stop control; earlier groups remain readable history.
  In Codex DMs, an accepted follow-up takes over the live indicator; separate
  threads keep their own.
- A Goose agent's Activity lists the sessions Buzz recorded on this device for
  each conversation. When a conversation has none recorded, Activity finds its
  sessions in goose's local history by the conversation they were tagged with.
  Sessions from before Buzz tagged them aren't found, and watch and timer
  turns from before Buzz recorded where they started aren't listed.
- Confirmed failures keep **Couldn’t finish** visible after the working indicator
  stops, even when the agent sends no reply. Cancelled requests show **Stopped**.
  There is no viewing timer. Outcomes supplied only by live activity may be lost
  after restarting Buzz; signed failure messages remain in conversation history.
  An uncertain status does not create an error balloon.
  Expand the summary to read the explanation and recorded updates, view Activity,
  or use supported recovery actions. The expanded outcome sits below **Collapse**;
  collapsing keeps the outcome visible.
  For your remote agents, Buzz checks again automatically when no final result is
  available yet, or after a temporary lookup failure, while you stay signed in
  and connected. Requests sent to several agents keep each agent's outcome visible.
- Automatic failure explanations share the related activity history when linked
  to the same request. Otherwise they have their own expandable outcome bubble.
  Ordinary replies and partial results remain visible. Failures of channel
  requests also appear in the channel.
- For agents running on this device, expanded outcomes can offer **Retry** to ask
  again and **Dismiss** to hide the outcome for the current app session. Dismiss
  does not delete a recorded failure message; it can show the outcome again after
  restarting Buzz.
- Any agent running on this device can read and change some Buzz settings
  here when you ask it to: appearance mode, interface size, accent color,
  vibe level, where new threads open, Solo follow-up behavior, automatic
  spelling correction (Mac only) and remembering mentioned agents. It can
  also change your Bestie (see **Make my bestie**). There is no switch to turn
  on. A change shows as not saved when it is active but could not be saved on
  this device.

Saved teams from **Your teams** appear in the inline `@` suggestions and the
mention picker. Select a team to insert its members as individual mentions.
Typing its name alone does not notify it. Empty teams, teams with more than 32
members, and teams with unavailable members cannot be selected; edit the team or
refresh the choices. Adding people to a channel still requires the normal send
confirmation. **Delete team** asks first; it doesn't delete the team's agents.
Closing a team's editor with unsaved edits, by Escape, its Close or another
tab, asks **Discard changes?** first; **Keep editing** keeps them.

## Optional features and limits

- Plugins can add features. **Settings → Plugins → Manage plugins** controls
  them. Unsigned external plugins can install and run by default. Launch Buzz
  with `BUZZ_REQUIRE_PLUGIN_SIGNATURES=1` to require signatures; restart with
  the variable unset or set to `0` to turn enforcement off. When enforcement is
  enabled, unsigned installations remain blocked until replaced with signed
  releases. Use **Update** in the plugin’s Settings details to apply a signed
  release, even when its code has not changed. Supplied signatures are always
  verified. Plugins built into Buzz are exempt.
  Do not assume a particular optional plugin is on.
  A page whose plugin is turned off says so, and its **Manage plugins** opens
  that plugin, where **Enable** turns it back on.
  If a plugin hides the focused Team sidebar row, keyboard focus moves to a
  remaining row in its section, or the section heading when none remains.
  A saved plugin sort can briefly wait for its plugin at startup, within the
  sidebar's 1.5-second loading budget. If unavailable, it falls back to A–Z
  without forgetting the saved choice.
- In **Settings → Plugins → Manage plugins → Add**, copy a plugin listing’s
  **Ref** into **Branch or tag**. Leave it blank to scan the repository’s
  default branch. If Git reports a size or repository-entry limit, try a ref
  with a smaller plugin source or ask the publisher for a plugin-focused ref or
  repository. If the message says the repository has more than 20,000 files,
  choose **Back** and enter the plugin folder in **Folder**; a smaller folder
  can bring that file count under the limit.
- On desktop, plugins can support update checks and set them on or off by default.
  Use **Check for updates automatically** in the plugin's actions menu to change
  this choice. Buzz saves your choice across updates and restarts. Plugins without
  update support keep their existing manual import flow. Buzz checks eligible Git
  sources at startup and once per hour while the app is visible. Checks do not
  install or reload plugins. A notice offers **Update and reload**, or
  **Review permissions** when access increases; either opens the update review.
  Even when access is unchanged, choose **Update** in that review to install and
  reload the candidate.
  Click the notice body to open that plugin’s update checkbox in Manage plugins.
  Its Update, Later, and Dismiss controls keep their own actions.
  Save unfinished forms and stop active plugin workers before you update.
  **Later** hides the notice for this candidate until the next app run. The
  update stays in the profile menu under **Plugins**. A newer candidate can show
  a notice again. A check that fails shows no notice; the plugin keeps
  working. Its row in Manage plugins says **Couldn’t check for
  updates.** with **Check again**, and Git’s own text under **Details**. Buzz
  skips background checks while offline and checks again when the connection
  returns, including a check that failed because the connection dropped.
  **Check again** clears the row while it checks; if the check fails again,
  the row shows the failure again. When Git couldn’t find the repository, or
  asked for a sign-in Buzz couldn’t provide, the row adds a sentence saying so.
  **Check again** stays available, since access can be restored.
  If the updated plugin cannot start, use **Retry activation** or its recovery
  menu to **Roll back**, when available. Checks, review, Later, and
  cancellation keep plugin work running.
- A `buzz://plugin-install` Git link pinned to both a commit and a folder can
  update a plugin installed from that same repository and folder: it opens an
  **Update** review showing access changes and any change to the branch or tag
  later updates follow, and the plugin keeps its enabled or disabled state.
  Other links to an installed plugin offer **Open in Buzz**.
- **Bestie** starts on, and **Reminders** and **Workflows** start off, on fresh
  local installs. Upgrades preserve their previous state, including Bestie off
  when no choice was saved. Enable or disable them in **Manage plugins**; saved
  choices persist. A deliberate plugin-settings reset uses the current defaults.
- A plugin's details in Manage plugins link to the Settings sections that hold
  its settings: sections it adds, such as GitHub comment authors, and Decisions
  API for a decision provider, such as TypeSafe. Only sections the Settings
  sidebar currently shows are linked. Back from one returns to those details.
- When Builderlab and TypeSafe are available in **Settings → Decisions API**,
  the **Decision provider** dropdown chooses Builderlab or TypeSafe. Each choice
  uses that provider for requests. Choosing TypeSafe without a key opens
  **Connect TypeSafe**, with a link to create a key in the TypeSafe console.
  Saving the key completes the switch; closing setup keeps the current provider.
  If a selected Builderlab account lacks Decisions API access, the pane explains
  that you can use your own TypeSafe key or contact your account administrator.
- In **Settings → Decisions API**, TypeSafe’s saved API key stays masked. Its
  chevron menu offers **Replace / Remove**. Replacement starts blank and masked,
  with inline **Cancel / Save** controls. **Save** stays disabled until you enter
  a key; removal asks for confirmation before
  deleting the key from this device’s secure storage. Settings cannot reveal or
  copy the saved key.
- Some plugins let the person's other agents on this computer, such as Claude
  Code, Codex or Pi, use their tools while Buzz is open. Those agents run the
  helper Buzz installs, for example
  `/Applications/Buzz.app/Contents/Resources/bin/buzz-agent-command tools` on
  macOS (inside the app's installed name, such as `Buzz Foundation.app`), with
  no setup or token. Without such a plugin there are no tools to
  offer; do not promise them.
- **Settings → Plugins → GitHub → Links → Open GitHub links in Buzz** controls
  whether supported GitHub links and the linked-PR shortcut open in a side
  panel or your browser. It starts on and is saved on this device across all
  communities. Turning it off keeps pull request indicators and agent tools enabled.
- The **GitHub** plugin’s pull request panel offers **Queue for merge** when
  the target branch requires a merge queue. After confirmation, it queues the
  displayed commit and shows **Queued for merge**; GitHub controls when it merges.
- The GitHub pull request panel remembers where you left it for the app
  session. Opened again in the same channel, it shows the **Summary** or
  **Changes** view you left there; elsewhere it starts on **Summary**. A review
  with text that you haven’t submitted waits in **Submit review** wherever that
  pull request opens, from any channel. Submitting clears it. If the pull
  request merges or closes first, **Submit review** goes away once you close
  it. **Changes** and **Submit review** need the desktop app with `gh` signed
  in. Scroll position isn’t kept, and reloading the window or turning the
  GitHub plugin off and on forgets all of this.
- Some desktop plugins can upload images you provide to services they declare.
- Agents running on this computer can write plugins while the **Plugin
  development** plugin is on (it is by default). It gives them
  `plugin_authoring_guide`, `plugin_status` and `plugin_reload`. The person
  installs a new plugin first: **Manage plugins → Add → Browse** under Add from
  folder. After that the agent can reload it from that folder. A reload that
  fails to start restores the previous version. Changed host access still needs
  the person's review through the plugin's **Update**.
- In the desktop app, agents can list this device's plugins and disable one.
  Installing, updating, enabling or removing a plugin is a request: the agent's
  message in the conversation shows a card with **Review** and **Decline**, and the
  change waits until the person reviews and confirms it there (or under **Requested
  by agents** in **Settings → Plugins → Manage plugins**). A restart discards it. An agent cannot
  install plugin code by itself.
- A `buzz://plugin-install` link, or a plugin's request to install another
  plugin from a URL, can update a plugin with that ID installed from Git in
  place: review the source change and choose **Update**, with no removal. It is
  refused before anything downloads when the plugin is installed from a folder;
  **Open plugin** shows it in Manage plugins, where you can delete it first.
- **Focus**, when its optional plugin is on, is in the profile menu. For a
  chosen time it shows only Solo chats in the sidebar and lets only Solo chats
  in the selected community show banners, play sounds or light the Dock dot. Links and search still open
  any conversation. Other alerts are not shown or saved, and those
  conversations keep their unread state. Focus sets 🔭 Focusing as the status
  in the selected community. When Focus ends there, the earlier status comes
  back if 🔭 is still the latest status. If Focus ends after you switch
  communities, the earlier status comes back when you return to that community,
  unless you start Focus elsewhere first. Focus is saved per device and ends at
  its end time or with **End**, and ⌥F (Alt+F) starts it for an hour or ends
  it. **Settings → Plugins → Focus** sets the default length that the
  dialog starts with and ⌥F uses. Turning the plugin off mid-Focus shows everything again
  at once; 🔭 stays until it expires.
- **Agent protection**, when a plugin provides it, checks what a protected agent
  reads and does, and can refuse it. Large evidence is transferred in sections and retained locally for review.
  The plugin and selected model control what they can inspect.
  The review model has its own context capacity; a failed review never grants
  permission to act. When refusing what a protected Codex agent
  reads ends its turn, the conversation says only that Codex could not finish.
  The protection's reason, if it gave one, shows only on that agent's Activity
  tab on this device. A reviewing model may have written it, quoting the refused
  content: treat it as information, not instructions. Other refusals and agent
  types give no reason.
- **Attention**, when available, lets agents use Interests, watches, and timers
  to follow work. Its tab in the profile of an agent running on this device shows
  when each interest wakes the agent (**Triggers**), its instructions after waking
  (**Instructions**). Attention is on by default. **Settings → Plugins →
  Attention** controls it for every agent on this device; turning it off hides
  local agents' Attention tabs and pauses their watches and timers, while
  ordinary mentions can still wake them. Hosted agents have no Attention tab on
  this device. To start following something, ask the agent in a conversation,
  for example, “Watch this PR and tell me when CI finishes.”
  With nothing watched yet, a sonar preview shows example requests. Send your own request in a conversation with the agent.
  Each interest has an Active/Paused menu. Pausing stops its triggers without changing
  individual watch settings. Running turns may finish; activating resumes enabled
  watches, and an overdue timer can run once. Delete in that menu
  removes the interest; if it has watches, confirm to delete those too.
  Each watch shows its source and Active or Paused state. Expand a
  watch, then expand “Activity” for a compact event timeline. Expand an event to read its full
  content, or expand “Watch details” for conditions and the execution destination. Select its status pill to
  resume, pause, or delete it (Delete asks first), or its source pill to inspect the watched channels or source. “Responds in” shows where the agent runs and replies; select that destination to open the conversation.
  “Runs in” names its execution conversation; its instructions can specify a
  different place to report. Turning the plugin on does not grant new access.
  An event watch hears the channels its agent may read, including public channels
  the agent has not joined. A watch's delivery channel must be one the agent is
  a member of; the relay decides where the agent may post. On macOS and Linux,
  watched commands stop when their Buzz process exits.
  During a handoff between Buzz builds, the new copy waits for the previous
  command to stop, then continues the watch.
- **Shared compute** is off by default; enable it in Settings → Plugins, then
  turn on sharing separately. **Mesh agents**, when it is enabled, use saved Interest
  instructions for watched turns in both Chat and Agent mode. Watched messages
  are context for that Interest; later direct requests do not inherit it. Mesh
  agents respond only to their owner.
- **Solo workers**: where a plugin offers it, an owner can authorize one agent to
  start, message, read, stop, and archive the owner's workers in Solo chats. The
  agent asks the owner's Buzz in a private channel with only the two of them;
  the owner's Buzz decides each request and must be running to answer. No
  answer does not mean nothing happened. Unless the agent names another person,
  it uses only the authorization from its own owner, as Buzz records it; an agent
  with no recorded owner must always name one. Without that authorization, or once
  the channel is no longer private, the agent's Solo worker tools find no owner. The
  standalone Buzz MCP server checks that channel's members and privacy against
  the key its relay advertises; where the relay does not advertise one, the
  tools find none.
- Agent text edits retain the message's current attachments, including removals
  made by an earlier edit. Editing requires a community that supports effective
  edit lookup; if that read fails, the tool leaves the message alone. The agent
  must still have permission to publish every retained file.
- The community authorizes reads and writes. An agent's name, profile, picture,
  or appearance in a list does not prove access, ownership, or running status.
  When helping someone explore a community, use only your available access and
  say when information is incomplete or inaccessible. Never join, invite, share,
  or change community content merely to explain how Buzz works.

On macOS, `just desktop me` debug builds keep their Keychain items through a local
credential helper, so Keychain asks once per item rather than after each rebuild.
See [local credential helper](identity.md#local-credential-helper-on-macos).
Release builds ignore it.

### Builderlab in development

With the pinned-viewer development server, Settings → Plugins → Builderlab manages one sign-in for hosted communities, remote agents and apps. It survives app reloads while the server runs. Signing out or session expiry signs all three out. The credential stays on the server and is not saved to disk.

### Charts in messages

The optional **Charts** plugin, off until turned on in Settings → Plugins, draws
a `buzz-chart` code block as a chart. Anyone reading the message needs it on;
otherwise they see the JSON. The block holds strict JSON (no comments or
functions), up to 60 KB. **Expand chart** shows it larger and **View data rows**
lists the plotted values as text.

````
```buzz-chart
{"version":1,"type":"bar","title":"Open issues","x":"team","y":"issues","data":[{"team":"Web","issues":12},{"team":"Relay","issues":7}],"source":{"name":"Issue tracker"}}
```
````

- Version 1: `type` is `bar` (at most 40 rows), `line` or `scatter` (at most 200),
  with `title`, `x`, `y` and `data` rows of those two fields. Every `y` is a
  finite number. Bars use text `x` values. Line and scatter use numbers, or set
  `"xType":"temporal"` for ISO dates (date-times need seconds and a timezone).
  Bars and lines need unique `x` values; aggregate first. `series` names a field
  that splits rows into colored series. Charts use four colors, so the series
  after the third are summed into one **Other** series; give your own totals when
  a sum would mislead.
- Version 2: `{"version":2,"title":"…","height":360,"option":{…}}` where `option`
  is an Apache ECharts option with its data inline (`dataset.source` or
  `series[].data`). Series types are bar, line, scatter, pie, heatmap, funnel,
  gauge, boxplot, candlestick, sankey, treemap and radar. `height` is 160–900.
  Colors come from the theme: the fourth color is followed by the first again,
  so keep a chart to four series, slices or nodes when readers must tell them
  apart. Links, images, graphics, toolbox, custom series, HTML in tooltips and
  `inside` zoom are removed.
- Optional `"source":{"name":"…","url":"https://…","metric":"…"}` shows
  attribution under the chart; it is not verified. `note` adds a caveat line.
- An invalid chart shows its error and source instead of drawing.

Code blocks draw the same way, through plugins such as Charts and Mermaid, in
Canvas, shared notes and repository pages. Those, plus the memory panel, agent
transcript replies and plugin READMEs, offer **Copy code block** on each code
block.

### Saved External apps approval

External apps can request saved approval. The app can renew valid approval
for another 30 days. Approval expires after 30 days without renewal. Buzz shows
this policy before you authorize access. Expired or revoked approval requires
new owner consent. The app can restore the same access after Buzz or the app
restarts. Keep Buzz open in the approved community. Keys stay in Buzz. Use **Settings > External apps > Revoke access** to remove approval,
even when no session is connected; it asks you to confirm first. Full access requires new approval.

### Reconnecting an old agent in a DM

On desktop, **Connect [agent name]** may appear inside a DM with an old agent you own that is available to import from this computer. It preselects compatible saved harness, provider and model choices, and preserves saved effort settings. Choose another harness if the old type is unavailable or does not support inline connection setup; settings that were not saved use the selected type’s defaults. Review the inline controls; **Connect** stays disabled until the harness has a resolved model and provider, including usable defaults. If a saved Codex model is unavailable, choose another model or harness to continue. Complete installation or sign-in if prompted, stop the agent in old Buzz, then choose **Connect**. Your agent keeps its identity and conversation. This does not resend earlier messages. The same private card can appear in a channel or thread after you send a new mention of an eligible agent you own while that conversation is open, if that agent is still a member of the channel. Loading older mentions does not show cards, and known-archived agents are excluded. Only you see it, once per agent in the loaded conversation. Choose the **X** in the card’s top-right corner to hide that agent’s card in this conversation; the dismissal survives reopening and reloads. After connecting, **Ask the agent to respond** explicitly queues a follow-up addressed only to that agent in the original message’s thread; it does not automatically replay your request. If no prompt appears, use **Agents → New agent → Import an agent**.

## Choosing a channel for a workflow

When creating a workflow, direct-message choices use participant names when available. Search
matches the displayed participant name. When no participant name is available, Buzz shows a short
public-key prefix. A direct message with yourself is labeled **Notes to self**.
These labels only help identify the conversation you select.

## Deleting an agent’s workflow

In **Workflows → Owner → All channel workflows**, open the workflow’s actions
menu and choose **Delete workflow**. You can delete workflows you authored or
workflows authored by an agent whose ownership Buzz has verified belongs to you.
This also works when your channel role is Guest.
Confirm the deletion; pending or uncertain results remain in the workflow notices.
If permission changes during confirmation, Buzz explains why deletion could not
start and keeps any editor draft.
Owning the agent does not grant permission to edit or run its workflow.

## Workflows in archived channels

In **Workflows**, an archived channel’s group says **Archived**, as do its workflows under **Recently updated**. Their runs would fail, so **Run now** and turning a workflow on are unavailable, and the editor saves a workflow only while it’s off. You can still turn an enabled workflow off, from its row or the editor, or delete it. **New workflow** doesn’t offer archived channels.

## Draft diagnostics

Desktop builds save a small local trace when a draft conflict or save failure
occurs. It contains operation metadata, with no draft text or secrets. See
[draft diagnostics](draft-diagnostics.md) for the file location and collection steps.

## Plugin account actions

Plugins can add actions to your avatar menu. Profile-related actions may appear just above Settings; other plugin actions appear below it.
