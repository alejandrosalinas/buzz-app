# Huddles plugin

**Huddles** is enabled by default on desktop (macOS, Linux and Windows) and can be turned off in
Settings → Plugins. Click the headphone button immediately after members in a
channel or DM header to join the latest available Huddle or start one when none
is found. The Huddle window opens and receives focus by default once connected. The mini
player stays visible beside search at the same time. Closing the window or using
its minimize control keeps audio connected; the mini player can reopen and focus it. If opening fails, the mini player stays available to retry. No side panel opens
and the header shows a green headphone/divider/chevron capsule only in the chat
where your call is connected. While a connection is pending, the header button offers Cancel Huddle connection; canceling releases audio and ignores a late connection result. Its headphone changes to a leave icon on hover or
keyboard focus, and clicking leaves the call. Elsewhere the neutral headphone
focuses the existing player. Its Add someone menu opens the existing member
picker for the Huddle's private room. Adding someone grants access to the room's
audio and thread, including when the Huddle started in a DM; the original chat's
membership and messages remain private. The copied Buzz channel link still opens
the original chat and is only useful to its existing members. Microphone access
follows the explicit Join click.

Room invitations require the parent marker written by this app; Add someone is
unavailable on older unmarked rooms. The recipient uses the relay's signed global
44100 membership notice, checks its target, inviter, current room membership and
parent metadata, then presents the existing incoming request in both views. The
notice may arrive before discovery grants local room access, so the finite recovery
reads by relay author and recipient, without a channel filter. Requests from before
this activation, self-adds, archived rooms and ordinary channels do not ring.
Joining an existing room can use its signed roster or the original chat's roster;
creating a new Huddle still requires membership in the original chat. When audio
auto-admission adds a parent-chat member without publishing discovery, the client
confirms its own room membership with a role-preserving 9000 after the audio
handshake, then re-reads the signed roster. This happens only when that room's
initial signed roster did not include the viewer; it also emits the relay's normal
member-joined notice. A failed confirmation reports an incomplete join instead of
granting local chat write access from audio participation alone. The audio
relay remains authoritative for creator linkage and current admission. Explicit
access revocation ends the call even during an incomplete roster refresh. Admission
retains its original authority: a parent-admitted call still requires current parent
membership after automatic room admission; a room-only invite retains room authority.

The mini player matches the neighboring 32px shell controls, with matching internal
buttons, 16px regular-weight icons and 20px avatars. Its end buttons sit flush
against the outer edges, with 4px before the microphone and no gap on either side of the Audio settings/Leave divider. Waveform and avatar content has
4px padding, with an extra 4px on the waveform’s left side. It uses the shared
primary glass material from the shell controls and offers audio activity, an
avatar stack of actual participants, mute, and a text-only Leave button. Leave keeps its Red 10 label with a muted red
fill on hover and is separated from Audio settings by a subtle divider flush against both button containers.
The divider hides while either adjacent button is hovered.
The neutral glass controls use the white chrome hover in light mode and its dark-mode counterpart.
The proposed `text-call-leave` role preserves the requested Red 10 in both themes.
It is a documented contrast exception for these controls: the light-mode Leave
label measures 3.09–4.37:1 across its opaque fills; dark-mode APCA is Lc 35.2–40.4.
Glass depends on its backdrop and is not certified by those opaque measurements.
The separate window uses shared round glass controls for microphone, chat, and Leave,
with a Red 10 Leave icon. Incoming requests use a large centered portrait over
blurred profile artwork, with a red decline icon on the left, a green join icon
on the right, and the caller label between them. Initials scale with the portrait
and render at 50% opacity.
New arrivals slide
and scale into the front of the stack; reduced motion removes that movement. The
latest four avatars remain visible, with a matching avatar showing the count for other participants. Click the
waveform or avatars once connected to open the
separate Huddle window. You are centered alone; in two- and three-person calls,
you move left as peers gather on the right in a mobile-inspired cluster. With
four or more participants, you anchor the center of a surrounding peer ring.
Up to ten peers appear, with an overflow count for larger calls.
Names appear on hover or keyboard focus. In small calls, nearby portraits shift
aside for the active name capsule, then settle back when it closes. In the ring,
names sit inside portraits without moving neighbors. Only one name is shown
at a time; reduced motion makes the layout change immediate.
A four-pixel ring appears around each speaker at 50% opacity, responding to
their own microphone or received audio, then fades after speech stops. The ring
uses blurred avatar artwork inside a crisp stroke; initials use the neutral
fallback tint. The compact player keeps its waveform. Muting clears only your
ring. Portrait scale and rotation respond subtly to speech with softened motion.
Window portraits fill the stage: solo artwork can reach 320px; duets use roughly
42% of the stage width per portrait, and groups retain a tightly packed cloud of
varied sizes. Portraits gently grow with their audio level.
Arrivals fade in with a slight rotation and a spring that overshoots before settling.
Reduced motion removes the rotation, scale, and speaker growth. Closing that window or navigating to another conversation
keeps audio connected. Leave releases the microphone and closes the companion.
Native call completion also retires it after a renderer reload/crash. The companion
has no identity, signing or microphone permissions. Failed companion updates also report their error in the main app toast stack,
instead of silently ignoring the chat button. Connection failures appear
in the shared app toast stack without showing the compact player; the headphone
button can retry them, and dismissing the notice clears the failed call.

Disabling the plugin, losing channel access, replacing the relay session, or
switching community ends the local call. If the UI disappears, the native call
expires after its client heartbeat stops. A failed audio connection exposes a
manual join retry. Recent-room discovery is advisory: it uses signed lifecycle
events, and the audio relay checks current membership, creator linkage and archive
state before admission. A rejected recent candidate is removed for this plugin
activation when the relay says it is inaccessible or ended; the generic admission
response does not reveal whether it was archived. Incoming lifecycle discovery runs while a conversation header is visible. A green
headphone offers Join for a recent remote Huddle, and clears on end, expiry, or
conversation/community changes. Microphone capture still requires an explicit click.
If the native authorization assertion expires during a call, audio ends and requires
an explicit rejoin; the next join gets fresh authorization and repeats NIP-42. Huddles
do not reconnect automatically.

## Audio settings

The gear beside the compact microphone (before the Leave divider) and the
ghost button at the companion’s bottom left open the same Audio settings popover.
Choose a microphone or speakers, or follow the system default. Choices apply to the
current call and update both views; changing the microphone preserves mute. Device
lists refresh when hardware changes and whenever the popover opens. If switching
fails, the previous device remains selected and the popover reports the error.

Capture and playback routing stay in the main window. The companion sends only
call-scoped selection actions. Speaker selection uses WebKit's media-element output
routing; hosts without that API retain system-selected speakers and explain this in
the picker. Leaving releases pending and active device resources. No push-to-talk
or gain controls are included. Physical device switching still needs a native tryout.

## Incoming DM requests

A new Huddle started by another member of a DM appears in both the glass capsule
and the focused Huddle window, even while viewing another conversation. Both show
the caller's avatar and equal-width Join/Decline controls. The compact capsule uses
opaque Green 10 and Red 10 fills with inverse labels in both themes; hover uses
step 9. This bright-fill/inverse-label pairing retains its scoped contrast
exception and does not meet every normal text contrast target. The compact label
is “[Name] calling”, with equal padding above, below, and before the avatar.
The window uses round glass icon buttons: decline on the left and join on the
right, with accessible names and red/green icons. Its single-line “[Name] is
calling” label sits between the controls; long names truncate. Channel Huddles
keep their existing header and card join controls without opening an incoming request.

Accepting keeps the caller visible in both surfaces while the connection is prepared,
with Cancel available. Once connected, Motion moves and scales that same avatar
into its final stack/cloud position over 280ms. Each surface has its own layout
group; reduced motion skips the shared movement. Minimizing while accepting keeps
the window minimized after connection, and a renderer reload clears pending requests.

Incoming DM requests ring with `public/sounds/huddle-ping.m4a`, copied from the
user-provided `Pow Sounds/ping.m4a`. One main-window player finishes the clip,
waits one second, then repeats. Both surfaces share it; closing/minimizing the
window leaves the ring active. Joining, declining, request retirement, or disabling
the plugin stops and releases it. If browser autoplay requires interaction, it
waits for that interaction instead of repeatedly retrying playback.

Incoming requests do not capture audio. Join uses the normal audio admission path;
Decline dismisses that room for the current plugin/session lifetime without sending
a relay event or ending the caller's Huddle. Closing/minimizing the request window
leaves its compact prompt available. Requests do not interrupt an active local call.
Ended, expired, inaccessible, self-authored, and pre-activation starts are excluded.
The main renderer clears stale request windows on reload without retiring connected
calls. Request discovery continues from verified live events if its finite read fails.

## Conversation panels and cards

The chat button between microphone and Leave opens a panel beside the avatar
cloud as a flush region with a subtle divider, without separate rounded corners,
shadow or a close button. The same chat button closes it. The shared tabs separate **Thread** from **Live transcript**. Thread uses
the full regular rich-text composer, attachments, emoji, and mentions, with Enter
to send and Shift+Enter for a new line by default (the composer's send-key setting applies). The detached window sends typed requests
through a per-room capability to the main app, which retains upload preparation,
membership checks, signing, and outbox admission. GIF discovery and search also
run through this owner, using its community and the enabled emoji contribution;
the companion has no direct relay HTTP permission. The tabs stay above the scrolling content. Discussion opening uses the shared
PanelDock curve; closing finishes before requesting the native window resize.
Reopening interrupts the exit. Keyboard and reduced-motion toggles are immediate.
The regular composer owns its inset without extra huddle-wrapper padding. Thread uses
the existing relay session for message history, sending, and failed-message
Retry/Discard. Closing this panel or minimizing the window does not end audio or
cancel an accepted message delivery. Text drafts survive tab changes and reopening. Attachment drafts survive tab changes,
but closing the panel releases its local files. An admitted message clears its persisted
draft in the main app even if the companion closes before acknowledgment. The transcript tab is a placeholder: local speech
generation is deferred and no transcription is recorded by this version.

Both discussion surfaces use the shared message renderer for Markdown and attachments.
The main owner supplies resolved media sources through the native presentation DTO;
images open in the shared image stage without bypassing authenticated media. Native
companion downloads are limited to source/name pairs in its current connected Huddle
presentation, and use the existing bounded download command and safe file destination.

Start/end events appear as cards in the parent conversation. Active cards show
elapsed time beside the same avatar stack as the compact player, and one action:
Join (or Open for your current call) while active, then View after ending. View
opens the saved Huddle conversation in a side panel. Archived rooms remain
read-only. The display is bounded to the latest 200 visible messages (excluding membership and Huddle notices) and says when history
is limited; it does not delete earlier messages.

New rooms carry a parent marker in their signed creation record. Verified rooms stay
out of ordinary sidebar destinations; destinations without metadata are withheld
until they can be classified, preventing temporary unnamed room rows. The discussion reader verifies that
marker before reading or sending. Older trial rooms named exactly
`huddle-<first eight room-ID characters>` are also hidden when relay-signed metadata
identifies them as private, expiring streams. Names alone never hide a channel.
This legacy presentation rule does not establish a parent relationship; an ordinary
channel configured with that same name, visibility and lifetime is also hidden.
This only changes presentation: membership and messages remain intact. Unmarked
rooms can open when one of the latest 500 relay-signed join/leave/end events in
the parent identifies that exact room. User-authored cards and room names do not
prove the relationship. This fallback is shared with the detached composer;
current room access and archive state still control reading and writing.
Rooms without that evidence remain unavailable, including sufficiently old calls
outside the bounded lifecycle lookup. The marker and lifecycle
cards use the existing relay protocol; no server changes are part of this slice.

## Ownership and compatibility

- `bundled/huddles` owns the channel launcher, mini player and companion using existing panel
  contributions. It is enabled by default in both the frontend and native catalogs.
- `features/huddle` owns the reusable client controller, bounded Web Audio
  capture/playback, discovery and native adapter. A controller outlives panel
  mounts and is disposed with its plugin activation.
- `src-tauri/src/relay/huddle` owns one native audio connection, identity-bound
  admission, purpose-bound event construction, and socket cleanup. The pinned
  `buzz-audio-client` crate from `block/buzz` supplies the shared audio handshake,
  v2 wire format, Opus sender, and per-peer jitter buffer; it does not pull in the
  v0 desktop app or speech models. Receivers drain 10 ms frames and reset on peer
  removal/reassignment. Frames from multiple devices belonging to the same
  pubkey are mixed once per tick and clipped after summing. Socket writes go
  through their own queue (five messages, newest dropped when full), so a stalled
  send never blocks receive or playout. Microphone PCM uses a serial sender: at
  most four waiting 20 ms frames plus one in flight, oldest waiting frame dropped
  on overflow; mute discards waiting frames. Signing stays in the existing
  IdentityHost. Commands are available only to the main application webview.

This is a client-only implementation. It uses the existing private ephemeral
channel creation event (9007, TTL 3600), parent announcement (48100), authenticated
`/huddle/{room}/audio` endpoint and v2 Opus wire format. The relay owns participant
join/leave and last-person teardown. Before an announcement is attempted, a failed
creation is rolled back by archiving its temporary room. After the announcement
may be visible, the client never archives the room on a failed connection: others
may already have joined, so existing relay socket/TTL cleanup owns it.

The macOS bundle includes the microphone purpose string and audio-input entitlement.
Browser-only, Linux and Windows hosts do not expose the launcher in this slice.
Screen sharing and automatic reconnect are outside this version.

## Agent voice seats

An agent type can supply `voice(seat)` from `features/agents/service.ts`. The
seat supplies the agent record, room conversation, abort signal, output callback
and `ended(error?)`; resolved config, revisions, synced settings and team come from
the same launch resolver as text, and stay fixed for that seat. The harness returns
`input(samples)` and idempotent `close()`.
Output is 48 kHz mono, exactly 960 finite samples per frame; input is the owner's
48 kHz mono playout, up to 5760 samples per frame (native delivers 10 ms frames).
The harness owns turn-taking and interruptions; the huddles plugin owns eligibility and the
native connection. The record carries no tool authority: each harness obtains
its own authorized agent handle and applies the same protections as an owner
mention when adopting voice work.

Seats follow the owner's connected human call on this desktop. Each running
local agent with a voice hook must belong to the room itself, according to its
current relay roster, and have the signed-in viewer as owner. Pending, cached,
read-only and archived room projections cannot seat agents. Parent membership
alone does not qualify. Multiple agents can sit independently; owner calls on
other devices do not create seats here. Room resolution runs only when a local,
owner-matched voice candidate exists. Until it succeeds, no seat opens; a failed
read stays silent and can retry on the next roster or agent update.

Agent voices use the microphones' serial PCM sender, with the same limits;
leaving discards all waiting sends. Frames already submitted to native cannot be
recalled. This bounds retained media duration, not wall-clock delivery latency.

Native filters each seat's audio to the owner's current peer indices. The v2
media protocol has no occupancy epoch: a delayed packet from a previous occupant
can be attributed to the owner after an index is reassigned. Decoder resets do
not fence such packets; a strict owner-only guarantee requires a media epoch or
an equivalent relay ordering guarantee. The filter also cannot identify people
speaking near the owner's microphone. Eligibility loss or plugin shutdown
aborts both audio directions and closes the harness and socket, including late
open completions. A five-second heartbeat renews the native lease. A failed seat
shows an error in both the compact player and companion window; leave and rejoin
to retry. The public plugin-author barrel export remains deferred; bundled harnesses use the service
type directly. Platform support depends on the harness and native audio host.

Transcripts are posted once through `seat.transcript("owner" | "agent", text)`,
with only the room `h` tag. They never mention anyone or re-enter the transcribing
agent. Other agents’ explicit room watches see them as ordinary messages authored
by the transcribing agent. The host aborts the signal, then awaits `close()` before
releasing the seat reservation.

Teardown keeps the seat reserved until all closing work settles; native bridge
closure runs alongside harness closure, not after the surviving typed turn.

```text
seat.stop(): Abort the seat and stop its heartbeat once.
  |
  +-> abort: Stop audio callbacks and transcript publication immediately.
  |
  +-> harness close() (Codex: runtime.voice -> openVoice): Close media, await
  |     the surviving typed turn, then unsubscribe; new text waits on closing.
  |     |
  |     +-> openVoice.close(): Stop WebRTC and Web Audio, then stop realtime.
  |
  +-> bridge.close(): Await native opening, then close its audio connection.
  |
  +-> reservation release: Await startup and both close paths before reseating.
```

## Checks and tryout

`src/features/huddle/*.test.ts` covers cancellation, scoped session replacement,
plugin disposal, microphone denial and lifecycle discovery. Native Huddle tests
cover wire encoding/decoding, roster handling and command input validation.
`tests/browser/huddles.spec.mjs` exercises the header and mini player in Chromium/WebKit and real
Web Audio capture with Chromium's synthetic microphone. The local fixture is
`/tests/fixtures/huddles.html`; `?audio` requests a local microphone and sends no
audio or events to a relay.

These checks do not prove a live two-person call or packaged OS permission behavior.
The native tryout must verify start/join against another existing Huddle client,
two-way audio, mute, switching conversations, leaving, plugin disable and
community switching. Production audio remains unverified until that live tryout passes. A relay rejection
that audio is unavailable is an operator deployment issue, not microphone permission
failure. Every endpoint that can receive `/huddle/{room}/audio` must support the
relay’s Huddle routing; mixed server pools can make admission intermittent.


### Review follow-up validation

The release signer receives the microphone entitlement explicitly and the returned
signed app is checked for it and its microphone usage description. Linux candidate
build dependencies include system Opus. Actual packaged permission behavior and
Linux candidate runtime loading remain release-environment checks.

Discussion rows retain uncertain delivery separately from rejection. Retry keeps the
original outbox event ID; Discard only removes that local pending record. Recovery
hands keyboard focus to the surviving composer or message log. The detached window
uses the same regular composer and retains focus after Enter-send.

Discovery excludes expired or future starts. Ordinary search, completion, profile,
and exact channel navigation exclude Huddle rooms. Ordinary Inbox drafts and
message notifications also exclude marked Huddle rooms and withhold rooms whose
metadata is pending. Saved Huddle drafts remain available in the Huddle composer. Invited requests retire on a
matching relay end. Incoming DM calls and room invitations expire after 60 seconds, independently of
the room lifetime; an expired prompt does not end the call or remove later Join access. Invited outsiders
cannot receive the private parent's end event, so their prompt may remain until
that deadline; stored metadata does not reflect every automatic archive. Joining
still rechecks current room access on the relay.

## Room classification

Only a signed kind-9007 creation receipt with the exact room ID, matching the
creator recorded in relay-signed metadata, establishes a verified Huddle parent relationship. The receipt
must declare a private stream with the Huddle parent marker. Later edits to the
name, description or lifetime cannot establish that relationship or
change an established Huddle's parent. Receipts are retained with signed discovery
metadata in the local cache. Strong exact-channel resolution awaits creation
proof from the writer, even after an earlier replica lookup found no receipt.
Proof-read failures reject that resolution so invitation recovery can use its
existing bounded retries; newer accepted metadata remains the proof source.

Background proof reads combine up to 250 channels and their creators per filter.
If a response reaches its limit, channels without an exact receipt from their
own creator remain eligible for a later refresh. Cross-author and ambiguous
channel matches consume response space but do not complete those proof reads.

Rooms without that evidence, including legacy Huddles whose creation events did
not include their room ID, retain ordinary channel access. For presentation only,
relay-signed metadata identifying a private, expiring stream named exactly
`huddle-<first eight room-ID characters>` hides that room from ordinary navigation.
This legacy exception assigns no parent relationship; parent verification still
requires independent signed evidence. Other unproven rooms remain ordinary
navigation destinations. A missing or failed receipt lookup never removes channel
access. Relays without creator identity metadata also use this fallback.

## Portrait interactions and controls

Window portraits support temporary drag-and-toss play: direct pointer tracking,
release momentum, damped wall bounces inside the participant stage, and a spring
back to their current layout positions, with a firm return and restrained rebounds. Re-grabbing interrupts the throw;
resizing clears displacement. Reduced motion keeps dragging but returns portraits
immediately on release. None of this changes participant order or call state.

The connected window's bottom bar keeps mute, chat, and leave centered. Audio
settings sits at the left padded edge and minimize at the right, vertically
aligned with the main controls. Both are large ghost buttons with matching 22px
icons in the secondary text color. When the call area cannot fit all five
controls, the main controls stay centered on the first row and settings/minimize
occupy opposite edges of a second row.

Window artwork has a stable per-person tilt within ±10°. Speech gently nudges
that angle; reduced motion keeps the resting tilt without speech-driven rotation.

With four or more participants, the local portrait anchors the center and peers
form a surrounding ring. The whole composition fits the participant stage’s
width and height, with space reserved for speech emphasis and names. Dense calls
reduce peer diameters to preserve separation; the existing overflow indicator
remains. Solo, duet, and three-person calls retain their small-call arrangement.
Names in the centered layout reveal inside the portrait’s lower edge without
moving the group or covering neighboring portraits.
