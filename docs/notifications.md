# Notifications

The host provides one `notifications` service for built-in messages and trusted
plugins. Settings → Notifications stores account-local choices: alerts are on
by default, subject to system permission; master off preserves category choices.
To pause all alerts and permission requests in a local dev server, set
`BUZZ_DEV_NOTIFICATIONS=0` in `.env.local` and restart the server. Only `0` pauses
notifications; unset or any other value keeps normal behavior. This development
gate never rewrites saved preferences. Settings shows the pause and how to remove
it; normal behavior still honors account choices and system permission.
Production builds ignore this variable.
Notification sound is app-owned on browser and desktop: Buzz bundles a set of
alert sounds under `public/sounds/`, and the notifications service plays the
per-category selection (with a shared default) in the running app after a
banner submission is accepted. OS banners are always submitted silent, so the
system never plays a second sound: the browser banner sets `silent: true`, the
Windows toast is built with silent audio (`sound(None)`), Linux Notify sends
the standard `suppress-sound` hint, and the macOS backend never sets a sound
name. Because a submission can resolve after state has moved on, the audio
decision stays under revalidation until the platform resolves it: any interval
of Sound turned off, the category set to Silent, alerts or the category disabled,
or revoked access/eligibility cancels the sound for good (without affecting the banner),
and the sound also requires the same live account generation and currently
allowed, eligible, Sound-enabled state when the submission is accepted.
Selecting a different sound in Settings previews it immediately; loading or
restoring settings never plays a preview. Silent stops the current preview. The
Sound switch turns playback off without disabling alerts. Each category also offers
Silent, which is saved like other sound choices and suppresses that category’s
audio without changing its desktop alerts. Silent has no audio preview.
A saved sound name this build does not bundle (chosen on a newer build, for
example) restores as the default for that category only. Alerts and the other
choices stay as saved. Restore writes nothing, so a later upgrade finds the name
unless a notification setting was changed on this build in the meantime: any
change saves all four categories as currently restored, replacing the name.

```ts
export const inject = ["notifications"];
export function apply(ctx) {
  const updates = ctx.notifications.register({ id: "updates", label: "Updates" });
  // In response to a real domain event:
  // await updates.submit({ sourceKey: event.id, target: typedOpenTarget });
}
```

Categories use existing installation ownership. Disabled/replaced plugins cannot
submit new alerts. A notification click belongs to the host; opening never enables
a missing destination plugin. `submit()` means a candidate was accepted for policy
checks, not that an OS banner was displayed or read.

## Running-app behavior

- Built-in mentions, DMs and conversation replies
  ([relevant replies](unread.md#relevant-replies)) consume the selected
  community's verified live kind-9 and kind-40002 traffic and existing
  unread/visibility facts. Structured kind-40002 bodies use the same decoded text
  as message rows. No new socket, unread engine or background-community
  subscription is added.
- Workflow-owner attribution is not a mention. The shared
  [workflow mention classifier](unread.md#workflow-mentions) preserves explicit
  template mentions and other recipients; DM and relevant-reply policies still
  apply. This does not change notification settings or suppress all workflows.
- Local agent completions alert only for relay-verified Solo chats. Their agent
  replies do not also produce a mention alert. When Buzz is focused elsewhere,
  the existing app toast says the agent is done, names the Solo chat, and offers
  **View**; when another app is focused, the native banner uses the same completion
  framing: “Agent is done” and “View in Chat.” A focused, visibly active matching
  Solo chat stays quiet. Ordinary DMs keep their message alerts and do not receive
  an additional agent-completion alert.
- Messages signed `audience=agents` (coordination between agents) never alert,
  even when they mention the viewer. The unread engine applies the same rule
  ([quiet agent messages](unread.md#relevant-replies)), so badges, Inbox, thread
  activity and the Dock indicator agree with the alert gate.
- History, initial/reconnect replay and own messages stay quiet. Candidates older
  than two minutes (or over 30 seconds in the future) are ignored. Unknown read
  readiness waits; off/access loss cancels pending candidates. A reply whose
  conversation lookup is pending (attention `pending: true`) is held as a
  `thread` candidate and re-checked when the lookup decides it; it is dropped if
  it turns out not to be the viewer's conversation. The app-global binding
  starts the shared bounded unread observation even without Channels mounted.
  Remote-capable hosts wait for the initial marker merge (bounded observation or
  complete snapshot); local-only hosts wait only for local storage. Failed or
  cancelled observation does not release alerts. Visibility is checked after UI
  presentation, without publishing read intent.
- Channel Mute/Unmute uses the session's confirmed, encrypted `channel-mutes`
  preference, independently of whether Channels is mounted. Muted channels suppress
  DM and participating-thread alerts; explicit mentions still pass the channel-mute
  gate, not global off/category/read/access/permission gates. This does not introduce
  a broadcast notification category. Confirmed mute quiets ordinary channel unread
  styling and offscreen cues without clearing unread evidence. Muted channel and
  DM sidebar rows show a crossed-out bell immediately after their names and hide
  unread dots, including thread dots. Manual unread can still emphasize
  the name, and thread activity remains available. Muted DMs also suppress automatic
  unread emphasis; offscreen unread counts and avatar previews remain. Solo chat labels
  retain unread emphasis. Unread thread cues are distinct from participating-thread alerts,
  which mute suppresses. Unknown or failed
  preference reads hold non-mention candidates until explicit retry; a confirmed
  mute cancels pending candidates, including an in-flight permission check. Unmute
  does not replay cancelled alerts. Existing shown OS banners are not withdrawn.
  Hosts without preference decoding retain existing notification behavior; this
  slice adds no native preference adapter or automatic cross-device synchronization.
- Permission is requested explicitly from Settings where a browser needs a user
  gesture. A fresh pending candidate is reconsidered after Allow; a newer off
  choice still wins. Observable API errors are reported, never auto-retried.
- Running-session dedup is bounded to 2,048 source identities/two minutes; pending
  candidates are capped at 128. Browser presentation retains at most 128 active
  alerts, closing the oldest before retiring its callback. Desktop retains at most
  128 active callbacks/waits. On macOS the oldest registered card is withdrawn
  and closed before admitting the next request at capacity; on other desktop
  backends admission rejects at capacity. These are not durable exactly-once or
  cross-window guarantees.
- Browser and desktop clicks use the existing typed, account/community-scoped navigation path. It owns
  membership/provider checks and exact opening. Changing account invalidates old
  callbacks; changing community does not turn an old alert into a dead click.
  Loaded top-level targets use the timeline; off-window targets and replies use
  the existing thread panel with exact scroll/focus. Clicks never mark a message
  read; normal focused, visible dwell does.

There is no notification database, Recent notifications UI, cold/reload receipt
protocol, uniform OS withdrawal subsystem, or closed-app push. Preferences are
persistent; notification candidates are not. Built-in message banners show the
sender and conversation plus a short, plain-text preview on both browser and
desktop. This sends those details to the OS, where lock-screen/preview settings
control their visibility. Titles use the current shared profile/channel cache,
with a key fragment when a name is unavailable; optional names never delay an
alert or trigger additional reads. Previews use at most the first 4,096 source
characters, flatten CommonMark to at most 200 Unicode code points, omit raw HTML
and link destinations, and label images without fetching them. Empty or overly
deep content falls back to “New message”. This is an arrival preview, not a live
copy of subsequent edits. Plugin categories may pass an optional `title` and
`body`, which the host flattens and bounds the same way; without them the banner
keeps its generic category text.

## Current acceptance limits

The browser adapter works only in a running tab with the Notification API.
Desktop builds use one small Tauri bridge into native backends:
`UNUserNotificationCenter` on bundled macOS, the freedesktop notification
interface through zbus on Linux, and tauri-winrt-notification on Windows. Linux
uses the already locked zbus dependency directly because notify-rust's
send-then-listen wrapper can lose early actions. Alert sound remains app-owned
in the renderer. The main-window-only bridge carries display text and an opaque
presentation ID, never an account, credential or navigation destination. Its
Tauri response channel is registered before native submission.

Desktop clicks restore/foreground Buzz and then call the existing activation
closure. macOS installs one app-lifetime delegate at setup and routes body
clicks by request ID to the running presentation callback. Its foreground completion keeps
notifications in Notification Center without displaying a banner. Native
submission completion reports errors but does not confirm display; successful
submissions stay registered for clicks. Unbundled development processes do not
call UserNotifications or borrow Terminal's notification identity. Windows
retains its callback when the banner fades, because timeout is not removal from
Notification Center. Linux
requests the standard default action and checks that the notification service
supports actions. A single, sender-filtered receiver is armed on the same D-Bus
connection before Notify. It is drained while the reply is pending; first terminal
responses are retained by ID (maximum 128 distinct IDs, including other apps'
broadcasts), then correlated with the returned ID. Overflow reports failure and
releases capacity; this is not proof that Notify was never displayed. GTK's
standard present operation shows/restores/raises the window without the
framework's stale minimized-state focus guard. Compositor
focus policy still applies. Dismissal never navigates. Observable send/focus
failures reach Settings without retry; a focus error does not discard navigation.

On macOS the native authorization state is read from the same
`UNUserNotificationCenter` settings as Dock permission. Explicit Allow requests
Alert, Sound and Badge on a fresh identity only; prior denials and disabled
interactions remain system-controlled. Windows and Linux continue to report
unknown banner permission. Settings on those platforms omits ineffective
permission controls. The bridge accepts submission before waiting for
interaction: acceptance is **not** proof that a visible banner appeared. No
uniform withdrawal/receipt guarantee is promised.

Callbacks stop navigating after account change or frontend disposal. Native
click callbacks are bounded by capacity: the oldest OS card is withdrawn and
its callback closed before a new request is admitted. An individually dismissed
card without a delivered response may retain a slot until that boundary.
Reload/cold-start restoration remains out of scope.

Real banners require OS permission, an available notification service and
appropriate app packaging/installation. macOS development processes outside an
app bundle cannot submit notifications. For local macOS acceptance, install a
stable code-signing certificate (Apple Development or a trusted local development
certificate), set its name or SHA-1 as `BUZZ_DEV_SIGNING_IDENTITY` in `.env.local`,
quit other Buzz copies, then use
`just desktop-bundle --launch`. An ad-hoc signature changes its designated
requirement on every rebuild and is not a stable notification identity. Windows
development notifications may use PowerShell's identity. Test the packaged app
identity before claiming release acceptance.

Chromium/WebKit fixtures replace only OS/IPC boundaries; tests and native builds
do not prove actual permission dialogs, appearance, sound or foregrounding.
Report native checks and real banner/click results separately for each platform.

For macOS, Windows and Linux, manual acceptance includes background and minimized
Buzz, two distinct message/thread targets, immediate banner click, banner fade
then Notification Center click, dismissal without navigation, and old-account or
revoked-access rejection. A macOS pass is not Windows/Linux acceptance.


## macOS Dock unread badge

The host projects one dot from the selected community's existing unread selectors:
observed unread messages (including thread replies) or explicit channel-unread
intent. It is not an exact message count or evidence of complete history. Unknown
and observed-zero both omit the dot. Existing bounded evidence/read-state owns
startup and updates; this projection adds no relay reads, network subscriptions,
or storage. Confirmed channel mutes remove that channel from the projection without
removing its retained unread evidence, so unmuting can restore the dot. The dot
stays clear while mute preferences are unresolved. Personal space,
account/session changes, access loss and host disposal clear or recompute the
indicator. Disabling Channels does not stop host ownership. Desktop alert
preferences do not alter this unread indicator.

One ordered host writer calls a main-window-only command using Tauri's standard
`set_badge_label` API. macOS draws the badge; no custom artwork is supplied.
Windows, Linux and browsers have no shell unread indicator or badge Settings in
this version, and do not bind the unread projection or invoke the Dock commands.
Their existing banner behavior is unchanged. No taskbar overlay, tray icon/menu,
new image assets or tray dependency is added.

Observable setter failures appear in Settings; **Check Dock permission** retries
using current unread intent. There is no automatic retry loop or claim of OS
display acknowledgement.

### macOS permission setup

Settings → Notifications → Dock unread badge shows the actual macOS badge
setting. **Allow notifications and badges** explicitly requests Alert, Sound and
Badge for a fresh NotDetermined identity. **Set up Dock badges** explicitly requests
Badge alone when an already Authorized identity reports NotSupported. Startup,
focus, and **Check Dock permission** only read settings; they never register or
repair permissions. Denied authorization and explicitly Disabled badges are never
re-requested. macOS System Settings controls badge opt-out. Errors withhold the dot
and are shown; a later focus or explicit check can retry a failed read.

This permission capability requires an actual macOS `.app` bundle. Unbundled
`tauri dev` never calls UserNotifications or borrows Terminal's badge permission.
The native bridge is necessary because the official Tauri notification plugin's
current desktop permission methods return Granted without querying these settings.
Banner delivery uses the modern notification center and app-lifetime delegate.
Windows and Linux do not use the macOS permission bridge or display its controls.

### Validation boundary

Tests use real relay/unread services for projection transitions, deferred native
boundaries for ordering, default-adapter command dispatch, and mounted Settings
controls for explicit setup. Native tests cover the authorization/setting matrix,
no startup mutation, error recovery and rejection of unbundled framework calls.
No browser journeys are added: these contracts are below the browser layer.

These checks do not prove a visible Dock badge. Native macOS acceptance must
exercise startup/arrival/read clearing, account/community/access changes, reload
and exit under an isolated packaged identity. First permission, explicit
missing-badge setup, deny/disable and legacy-banner interaction also need native
acceptance. Distribution signing and packaged account support remain separate work.
