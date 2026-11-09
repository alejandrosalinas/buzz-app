# Shell design

The shell is owned by `src/app/shell`, independently of relay operations and page
content. `App.tsx` composes startup/recovery, built-in Settings, and the
existing contributed-page lifecycle. Messages is the default destination at
startup; legacy Home targets resolve to Messages in the same visit. Old version-1
Channels Inbox/Bestie routes resolve to their standalone pages in that same visit,
preserving community scope and normal plugin availability checks. Channels is
required, including when older preferences saved it disabled. Navigation removes
disabled optional plugins
from page choices; a retained destination whose provider is unavailable displays
an explicit failure with retry instead of silently selecting another page.
A page or Settings section already on screen is not replaced when a later
attempt on the same visit (a retry, a same-target open, a reopen after sign-in)
reaches the host's own deadline without an answer: it stays, and may still
update its address and answer late. A failure the page reports itself (a timeout
included), lost access, a removed page and a rejected incoming link
still show the host's failure, as does that timeout when it passes while the
host shows its loading state in place of the page. Loading that starts later over
a kept page shows the loading state, not the failure.
Browser controls, host shortcuts and toolbar arrows traverse the same visit history.
Settings sections are destinations presented as a modal over the last workspace.
The host retains that workspace presentation while Settings is current, without
allowing it to complete or redirect the modal's navigation. Returning to the same
visit resumes its request with preserved focus intent; page removal, scope changes,
failed ingress and other destinations revoke it. Cold Settings links have no retained
workspace and Close falls back to Messages. Cross-community Settings still selects
its addressed community, retiring the previous scope rather than retaining access.
Settings sections are destinations. Personal-space page visits use explicit null
scope, distinct from a plugin's unspecified community scope. Focus-only skip links
do not add visits. Plugin recovery remains available in Settings → Plugins → Manage plugins without
blocking Profile or Appearance.

See [design system and appearance](design-system.md) for Light/Dark settings,
semantic tokens, UI authoring rules and the local component reference.

## Where to change the design

- `src/shared/styles/globals.css` owns the semantic palette exposed to Tailwind:
  `ink`, `muted`, `line`, `soft`, `shell`, and `shadow-surface`. Default element
  styles live in Tailwind's base layer, so utilities can override them normally.
  Existing feature CSS variables remain available for incremental adoption.
- `src/app/shell/presentation.ts` owns page labels, icons and navigation ordering.
  Messages comes first, then Inbox, Reminders and Bestie; other contributed pages
  follow by displayed label with a full contribution-key tie-breaker. Sidebar
  navigation and page search share this ordering, independent of plugin
  activation/re-enable order. Primary pages choose `sidebar` (default, a row in
  the Messages sidebar) or `dock` (an app in the left dock) placement for
  contributed pages. `topbar` and `toolbar` are accepted aliases for `dock`.
  `PrimarySidebar` is the conversation sidebar: a capsule All / Solo / Team
  filter above one shared scrollport, Solo projects and chats above Team's channel
  sections, one relay-recovery notice, and the connection fallback. The filter
  never opens a destination or changes the open conversation; a new destination
  reveals the inventory its placement belongs to unless the filter is All. Both
  inventories stay mounted when filtered, retaining section state, and share the
  channel sidebar's surface, resize owner, row treatment and section recipes.
  Bestie and Inbox lead the left app dock, followed by Messages and the other
  dock destinations. Sidebar-placed contributions remain in the conversation
  sidebar; while one is open, `navigationOwner` keeps Messages selected in the
  dock and the conversation sidebar stays open unless the page supplies its own
  sidebar, which replaces it. The conversation sidebar's plus opens New for
  chat, project, DM and channel creation;
  Cmd/Ctrl+N opens that menu only where the current app has a creation sidebar. Every conversation, Solo or Team, opens in Messages; see
  [Solo](solo/README.md) for the Solo treatment, placement and the relay privacy
  boundary. Messages is the default destination.
  Page search lists every active page, including non-primary pages.
  Disabling an optional plugin removes its navigation entry.
  Channels is presented as Messages. Legacy tone props are retained for
  compatibility; all pages share the supplied gradient and repeating CSS dots.
  Presentation is keyed by full contribution identity, not plugin-local IDs.
- `AppShell.tsx` owns the header, contributed panel launchers, Settings access,
  community switcher, and page frames. Sidebar/history controls sit at the left,
  Search centers in wide windows and fills the available space in compact windows,
  and community/profile controls sit at the bottom of the left dock. Search retains 24pt side gaps
  and wraps only when its compact control cannot fit. The left app dock uses
  theme-accent selection and stable icon tiles. Outer content padding uses the
  same panel-gap token as the space between panes. The community trigger opens
  a shared Popover containing NavigationItem rows with their existing context menus;
  this richer picker retains community actions as well as switching. Arrow keys,
  Home and End move focus. Join and Create community appear at the bottom; creation
  opens the registered Builderlab settings flow. Dialogs return focus to
  the surviving community trigger.
  Switching pages preserves the desktop sidebar’s collapse preference. The
  manual toggle appears only where the selected app supplies a sidebar.
  The conversation sidebar and page-contributed sidebars share one saved
  per-community width and resize behavior.
  Settings opens in the shared expanded Dialog with an integrated sidebar; the
  workspace remains mounted underneath. Its portal fills the shell's workspace
  frame (navigation, main content and companion panels); the popup centers inside
  it, capped at 72rem × 48rem with shared dialog gutters. Narrow popups fill the
  host to preserve usable space. The host excludes the app
  header, with equal inline gutters matching the main page’s gutter. At widths
  up to 650px the frame also covers the wrapped header below its titlebar row. The frame
  sits outside the content query container so fixed modal backdrops still block
  the entire webview. Native traffic lights remain in their reserved titlebar
  area. The shared compact dialog header centers its title and Close action
  without a large empty band. Close and Escape return to the original workspace
  visit, including after navigating through several Settings sections.
  A selected page may replace the conversation sidebar through `Page.sidebar`.
  It receives the admitted workspace target and shell-generated Pages navigation
  as children, without navigation completion authority. Healthy sidebar state
  survives target changes and stays mounted beneath Settings. A failed sidebar
  shows an alert and scrollable page navigation in the standard frame; a new
  workspace navigation request retries it independently of the page body.
  Messages uses the conversation sidebar. Other pages show a sidebar only when
  they contribute `Page.sidebar`; apps without one hide the retained navigation.
  `App.tsx` composes `PrimarySidebar` around `features/channel-navigation/ChannelInventory`. The inventory supplies channel rows,
  notices, dialogs and scroll bindings through a render prop; PrimarySidebar owns
  the common frame, Solo/Team arrangement and error fallback. The fallback retains
  page navigation without remounting a failed inventory. There is no portal.
  Sidebar session state resets on scope/connection generation without remounting
  unrelated pages. Its own error boundary keeps page navigation and Settings usable.
  Page buttons use shared navigation rows and focus the main region on selection.
  At short heights page rows scroll with the channel list rather than in their own list.
  At widths up to 650px, Messages and pages with a sidebar contribution collapse
  navigation behind the header’s Show navigation button to preserve readable
  content at 200% text size. The 220px disclosure overlays content, supports
  Escape, and keeps sidebar state
  mounted. A navigation selection closes the phone drawer and hands focus to the
  main content for conversation selections. Settings owns its navigation inside
  the modal instead. On desktop, Messages and pages with a sidebar contribution
  use an animated "Hide sidebar" / "Show sidebar" toggle; hiding the sidebar
  preserves its mounted state and saved width. The combined Solo and Team sidebar
  is labelled "Sidebar". Reduced motion disables the transition.
  The header keeps history, Search and account actions. App navigation stays in
  the left dock at every width, with scrolling when its destinations exceed the
  available height. The dock uses vertical design-system Tabs with manual
  activation: Up/Down move focus, and Enter or Space selects the page while focus
  stays on its tab. Inactive pages may supply a rich hover preview; selected
  pages and pages without previews use instant right-side label tooltips.
  Each opening carries focus intent: dock activation suppresses destination
  autofocus, while explicit New conversation, sidebar and deep-link openings keep
  their content focus. This intent is not saved in addresses or history; retry
  preserves it for the same opening. A focused Retry navigation control hands
  focus to main once retry removes it, even if reconnect temporarily remounts
  the shell. A new opening or focus elsewhere cancels this
  handoff. A selected dock page is a separately focusable, labelled tabpanel.
  Dock destinations retain exact selection; sidebar-placed pages select Messages,
  and non-primary or missing destinations leave every dock tile unselected.
  Sidebar page links retain their exact route and focus main content when
  selected. Dock destinations never become companion launchers.
  The shell owns one joined Panel around navigation and page content, with a
  panel-gap outer gutter beside the dock, at the right and below. Nested Panels
  keep their opaque fill and clipping but drop individual borders, radii, and shadows. Layout
  owners add one-pixel semantic dividers. Document pages scroll inside the
  remaining viewport.
- `SettingsSidebar.tsx` composes shared SidebarNavigation with
  NavigationSection/NavigationItem content inside Dialog's integrated navigation.
  The same composition wraps SidebarFrame (the Solo/Team sidebar),
  preserving main's compact gray row appearance while features retain scrolling,
  unread, disclosure and drag behavior. `Settings.tsx` supplies the detail without
  another Panel, padding or scrollport. The modal owns the Settings title and
  persistent Close action; sections keep their centered reading column and forms.
  Standalone fixtures retain embedded navigation.
  Native buttons use normal Tab/Enter navigation and expose the current section.
  `ProfileSettings.tsx` edits the local default inline with Save and Cancel,
  sharing fields and validation with community setup. Cancel restores the saved
  profile; switching sections retains an unsaved draft while Settings is open.
  Closing Settings discards that draft, as leaving the former page did.
  Profile opens from the selected session’s already-verified kind-0 event while
  refreshing through that session, without another profile cache or retained
  Settings mount. Save waits for the fresh read; avatar editing stays available
  and completed uploads update only the latest draft’s picture. Its compact
  avatar preview uses the active session’s existing thumbnail media resolver,
  sharing the header’s cached URL without re-registering that destination or
  asking for original-size artwork. Visible editor avatars load eagerly; real
  image completion still owns readiness and failed-image fallback. A refresh keeps
  typed fields and updates untouched ones. Cold reads preserve form geometry;
  shared LoadingRegion delays status feedback for one second and shows errors
  immediately above the form with Retry. Community Save publishes only to its
  addressed community; Personal Profile updates the device-local default.
  Plugin rows retain accessible native-button switches and show only names and
  controls. A Folder/Git import area above the list previews plugin subfolders and
  requires explicit install/update; its draft survives section switching, but
  leaving Settings discards it. Import controls are desktop-only. Management errors remain visible.
  Switches use aria-disabled plus a busy guard so a management transition does
  not discard keyboard focus.

Use utilities for layout and component styling. Shared navigation states live in
small component classes; avoid adding unlayered global rules that override
utilities or reaching into a page's CSS module from the shell. Respect reduced
motion with Tailwind's `motion-reduce` variant.

## Desktop chrome

Tauri uses `titleBarStyle: Overlay` and `hiddenTitle` on macOS. Native traffic
lights have a reserved left area before the history controls only in the
macOS desktop runtime. Web gets no inset or imitation window controls. Linux
and Windows desktop use undecorated windows with app-owned minimize,
maximize/restore and close buttons in the header, including during identity
setup. While the parser-loaded launch overlay keeps app content inert, a
window-control header is portalled to the document body above the overlay; the
launch owner removes it when the normal identity or shell header becomes usable.
Drag regions are limited to the header background; controls remain clickable
when no modal is open. Shared Dialog and AlertDialog backdrops preserve dragging
only over the shell’s marked empty titlebar regions. A host-provided drag handler
hit-tests behind portal layers without forwarding clicks to blocked controls.
A press on the empty titlebar is a click until the held mouse moves at least
four physical CSS pixels. A click dismisses ordinary Dialogs; crossing that
threshold starts native dragging once and suppresses the trailing click. Release,
cancel and lost capture clear only the pending gesture; the next press resets the
close fence. A caller opt-out or in-flight close lock still prevents dismissal. Confirmations retain
their deliberate Cancel/confirm policy.
Without a modal, double-clicking that
background on macOS follows the current system title-bar preference (Fill/Zoom, Minimize,
or no action); changing the preference does not require restarting Buzz. Other
platforms retain Tauri's native drag-region behavior. The main-window capability
grants titlebar dragging and the internal maximize action used by that
handler. A Linux and Windows main-webview capability also grants minimize,
maximize/restore and close for the integrated controls. These actions do not
change the app’s existing close lifecycle. A native document-start policy hides
Minimize in Hyprland sessions and also hides Maximize on Omarchy (identified by
a nonempty `OMARCHY_PATH` within a Hyprland session), whose default window rules
suppress application maximize requests. Close remains available throughout launch,
identity setup and the shell. Other desktops retain their controls; non-Omarchy
Hyprland retains Maximize because its user-owned rules may permit it (Hyprland's
example configuration suppresses it too). This is a session-default policy, not
live compositor capability detection: customized Omarchy rules that re-enable
maximize are not inspected.
`XDG_CURRENT_DESKTOP` identifies the session (colon-separated names supported),
with `XDG_SESSION_DESKTOP` as a fallback when absent/empty. Tauri's Linux
`isMinimizable`/`isMaximizable` methods do not report compositor support.
No compositor configuration or window-action semantics are changed.
On Windows, the custom maximize
button does not expose native maximize-hover Snap Layouts, and right-clicking
the custom header does not open the native system menu. Keyboard and edge-snap
behavior remain native and require per-platform acceptance testing.
The main capability includes scoped
HTTP(S) opening for
[external links](channels.md#run-the-integration). See
[Tauri window customization](https://v2.tauri.app/learn/window-customization/).

The main desktop window uses Tauri's window-state plugin to save its size,
position, maximized and fullscreen state on normal app exit and restore them on
launch on macOS, Windows and Linux. State is local to the app's OS configuration
directory (`.window-state.json`); missing or unreadable state falls back to the
configured 1200×800 window. Visibility and decorations are not restored, so a
macOS window hidden by Close reopens visibly after Quit/relaunch and platform
chrome stays configuration-owned. Close/reopen without quitting on macOS still
uses the existing window. Before requesting placement or restoring maximized/fullscreen
mode, Buzz reads the plugin's saved geometry and checks that both ends of the 48px
client header are inside connected monitor work areas,
allowing a header to span adjacent displays and ignoring invisible frame borders. An
unreachable header falls back to the top of the primary work area (or the first
available monitor), shrinking an oversized client to fit. This covers partial
overlap after removing a monitor and fully off-screen saves; both use the same
fallback instead of leaving placement to the OS. Saved zero-sized geometry is
ignored. Validation uses requested geometry, not immediate getter results: native
setters may apply asynchronously (Linux/macOS), so getters can still report the
startup frame. The plugin remains the only state-file writer and owns mode
restoration. Linux placement remains subject to the window manager/compositor
(notably Wayland).
The plugin stores physical pixels, so changing display scaling can change the
window's apparent size. On macOS, quitting in fullscreen can preserve the
fullscreen-sized frame instead of the earlier normal size; leaving fullscreen
after relaunch may therefore produce a screen-sized window.

The top-right group contains full-page toolbar icons, enabled companion plugin
launchers, a page finder, and the local
avatar. Search, sidebar and history controls use unfilled ghost icon buttons with
32px containers, 16px icons and 10px corners, matching content-toolbar actions.
Their hover fills remain translucent over the colored backdrop.
Pressed fills are slightly stronger; icons keep full opacity. Plugin launchers
use the shared glass style.
Bestie is available in the Messages sidebar when its plugin is enabled. An
account-saved Bestie decorates that row with the agent's identity and promotes
its exact one-to-one DM there. Search Buzz shows the same agent identity with
**Bestie** as supporting text and matches either name. See
[`solo/README.md`](solo/README.md) and the bundled Bestie README for selection,
DM promotion and hosted-setup fallback ownership.
`ProfileButton.tsx` uses the selected community's profile when connected and
local defaults in Personal space. Its anchored account menu groups profile and
status controls above Appearance, Plugins and Settings. The avatar inside the
menu opens Profile Settings in either scope; Plugins opens its Settings section.
Selecting a Settings destination focuses the main region after the menu closes,
unless focus has already moved into the page. Contributed actions, including
Send feedback, follow Settings behind a separator that appears only when actions
are present. There is no separate top-bar Settings button.

The avatar dot and availability label show the same observed community presence,
not unconfirmed local intent. Online, Away and Offline use the shared compact
choice menu. Arrow keys move focus; Enter/Space selects without closing it.
Appearance uses the same compact recipe for Light, Dark and System, with a checked
choice and device-local persistence. Save failures remain visible in that submenu;
choosing a mode again retries. See [presence ownership and limitations](presence.md).
Escape, outside click and Tab leaving dismiss the account menu; Escape returns
focus to the header avatar.

Set a status has a soft inset fill without a border and keeps shared menu hover
and focus behavior. Its editor opens immediately from the session's cached status,
then checks the latest status in the background. Refresh cannot overwrite an edited
or submitted draft. While the draft is untouched, a check lasting about one second
shows progress and failures offer Retry; editing dismisses that feedback. Closing
or changing account/community discards the editor and fences
late results. Status signing and save admission remain with the existing session.

Avatar artwork uses the shared source/media owner, with initials on missing/failed
pictures or a person icon when unnamed. No sample person's photo is used as the
user's identity. See [community/profile ownership](communities.md).
`PageSearch.tsx` uses a native modal dialog for focus containment, Escape dismissal,
and searching available page destinations. Repository, PR and issue views live in
the enabled-by-default `buzz.repos` plugin, reachable through entity links without
a primary header destination. The retired Projects container has no directory or
entity type; old project links show a removal notice. Apps waits for a functional destination.
`CommunityPicker.tsx` opens Personal space, saved communities and Join/Create
from the active-community button beside the profile. The picker is the sole
community selector. It reads saved-community NIP-11 icons through the same-origin broker with at
most two concurrent optional reads, including inactive communities without
opening sessions; slow icon responses cannot occupy all foreground connections.
Unavailable or unsupported images fall back to a saved icon or name initial.
Discovered artwork is shared with the Settings community address through an
in-memory projection scoped to the Communities instance. Both prefer the same
validated discovered icon over saved artwork; Settings adds no metadata request.
Each saved community has a context menu (right-click, the ContextMenu key or
Shift+F10, labelled “Actions for <name>”) built from the shared context-menu
primitives, in the original's order: Mark all as read, then Copy community URL,
Invite to community and Community settings, then a separator and the destructive
Leave community. Copy writes the canonical HTTPS
origin and reports through the host toast stack. Mark all as read acts only on
the selected community's ready session and only while its read state can sync;
elsewhere it stays visible but disabled with a note saying why. Invite to
community appears only on the selected community, only when the relay-signed
roster names the viewer an owner or admin (the same roles the Membership
settings card reads) in both development and native builds; it opens the
Membership settings card scoped to that community. The picker reads
that roster through the selected community's existing session and verifies it
against the relay authority that session already holds, so the read adds no
session request to the connection and opens no other session. That card applies
the same role gate in native builds, with its member list, Invite members
button, direct additions and per-member actions.
A Settings section, history entry or `buzz://open` locator naming it still opens
instead of reporting unavailable. Community settings is
on every community and opens Settings scoped to that community's origin, which
selects it on the way. Leave community is on every community and opens an alert
dialog owned by the picker (“Leave <name>?”) whose destructive confirm shows a
pending state while the request runs; the menu item itself is disabled and reads
“Leaving…” for that community until the relay answers. The picker publishes the
NIP-43 leave request to the community's relay by origin, then asks the
communities service to forget it. The relay's acceptance or its "not a member"
answer removes the community and purges its device state; its banned answer
removes the community and disposes the session but keeps the device state,
because the relay still holds the membership while the ban lasts, and the
informational notice says the viewer is currently banned and the community can
be added again by its URL if access is restored, without promising permanence.
Any other refusal or an unreachable relay keeps the membership and reports the
reason. A failure after the relay has answered is the device's own and reads
that way: the community was left but this device could not finish cleaning up,
with the storage error's own words in parentheses, and leaving it again
finishes. Only the service call can produce that message; the host's selection
callback and the success notice run outside it, so a host that throws while
navigating is logged as its own error and the leave still reports success.
Saved data the purge could not clear is logged by store and adds a line to the
success notice. When the left community was selected, the picker routes the
fallback to Personal space through the host's selection callback so navigation
and ingress recovery match a click on Personal space, rather than leaving a page
scoped to a gone community. Focus
returns to the community when it is still saved; once it is gone, focus follows
the selection, to the still-selected community or to Personal space where a
left selection now lands. Closing a menu opened from the keyboard returns focus to
that community. Closing one opened by pointer returns focus to the field the
right-click interrupted: browsers focus the picker button on the click itself,
before the menu opens, so the picker remembers what had focus ahead of that move
and restores it while it is still on the page, and a right-click while typing
does not leave the caret on the picker. With nothing interrupted, focus lands on
that community.
Opening a menu or running any item never acquires an inactive session, and the
picker still claims no unread total: the unread capability provides bounded
observed evidence, not exact community totals ([unread ownership](unread.md)).

Visible copy uses Buzz, never “workspace.” The legacy `workspace` layout identifier
and CSS variable are implementation details retained for plugin compatibility.

## Assets

`public/` contains browser icons copied from Buzz's desktop icon family. Tauri's
PNG, ICNS, and ICO files are in `src-tauri/icons` and explicitly configured in
`tauri.conf.json`. Replace both sets together when the source branding changes.
The source attribution is in `NOTICE.md`. `public/shell-gradient.png` is the
exact supplied 564×1002 image, stretched across the shell to retain the complete
blue/yellow/white composition. A 36px repeating CSS radial gradient supplies dots
behind, never over, opaque cards; it makes no relay request at runtime.

## Review

Run `just iterate` for UI changes and `just scan` for the broader review checks.
Check Messages and Settings; toggle an optional bundled plugin off/on and confirm its
navigation entry follows; inspect a narrow viewport. On macOS, verify titlebar
alignment, dragging, each macOS title-bar double-click preference, and Settings
access in a built app.

## Messages

The host owns the single rounded outer surface and sidebar divider. Messages
owns flush conversation and contributed-panel regions separated by one-pixel
dividers. A single right panel fills the conversation height;
the right-column grid splits available height evenly between a local link card
and the launched companion card. The right column stays beside the conversation
whenever the workspace has room for both, accounting for sidebar width and
interface size. It overlays when the content pane is too narrow for two columns.
At 650px and below it fills the page area.
Each region contains its own overflow, keeping the composer and close control visible.
Ordinary thread opens show a loading status until bounded history and initial
bottom positioning finish; the first painted replies are already in place.
Exact-message links reveal their requested row independently. A reader’s scroll
gesture takes over immediately, and loading failures keep recovery visible.
Opening a linked detail from inside a thread adds a closable tab to the same
secondary pane. Profile activity, managed-instance, and owner-profile links use
`PanelContext.push` to select an existing target or add a tab; `open` retains its
replacement semantics. A shared 2.5rem header uses 12rem tabs composed from the sidebar's NavigationItem,
with 10px corners matching adjacent icon actions, profile avatars or detail icons,
and a trailing close button.
Switching retains mounted content, scroll position, and drafts. Each tab has a
close control; middle-click or Delete on a tab and Escape in its content close
that tab. Middle-clicking an inactive tab preserves the editor's focus. Closing
the selected tab selects a neighbor, and closing the last tab dismisses the pane.
Selecting a conversation from Search focuses its writable composer after the
search dialog closes. Message results retain their exact-message reveal behavior.
Cmd+L on macOS or Ctrl+L on Windows/Linux focuses the writable
composer in the focused pane. Outside a pane it uses the exposed main conversation.
The composer shortcut yields to terminal input, preserving shell Ctrl+L.
On macOS, Cmd+Shift+H focuses the main pane and Cmd+Shift+L the side pane.
On Windows/Linux, F8 and Shift+F8 cycle between visible panes. Pane focus resumes
the writable composer directly, falling back to the selected tab for tools without
a composer. On that tab strip, arrow keys move between tabs and Enter selects one.
Pane focus also works from the terminal, which captures Tab. When a destination is
available, Buzz consumes F8/Shift+F8 before terminal input; rebind Focus next pane
in Settings if a terminal application needs those keys.
Covered targets, hidden tabs and collapsed panes are skipped. These shortcuts preserve
drafts and selection and yield to modals and editor-owned key handling.
Settings → Shortcuts lists Focus message box and the platform's pane focus actions
(Focus next pane on Windows/Linux). Each action supports a device-local override
and reset. F6 retains notification focus.
Browser builds may reserve Cmd/Ctrl+L for the address bar; choose another binding
in Settings when using Buzz in a browser. Native key delivery is a separate host check.
On desktop, Cmd+W on macOS or Ctrl+W on Windows/Linux closes the selected
closable tab in the focused pane. If focus is in the permanent main conversation,
it closes the selected tab in the visible side pane instead. A selected closable
main-pane tab takes priority over that fallback. Hidden tabs remain untouched;
With nothing to close, Cmd+W on macOS closes the window while keeping Buzz and
running agents alive; Ctrl+W on Windows/Linux does nothing.
The macOS native Close menu uses the same action, including when an embedded
browser owns focus (embedded browsing is currently macOS-only). On macOS,
Cmd+Shift+W and the native **Close All Tabs** menu item close all tabs in the current channel,
including hidden side-pane tabs, just like the tab's right-click action.
A terminal tab closes its presentation, not its shell; Ctrl+W while typing in a
terminal remains shell word deletion on Windows/Linux. While a modal is open,
close shortcuts do nothing rather than closing content behind it.
Windows/Linux consume held-key repeats without closing further tabs or the window.
Window buttons and Alt+F4 always retain their window-only behavior. The bottom
terminal drawer keeps its existing Cmd/Ctrl+J/Hide behavior. Browser-build
shortcuts are unchanged.
Shift+Escape asks "Mark everything as read?" in the shared `AlertDialog` (Cancel has
initial focus; focus returns to the element that had it) and then runs the community
menu's Mark all as read action and toasts. `MarkAllReadShortcut` registers it as a host
shortcut only while the selected community's session is connected, and it is
unavailable without `frontier-sync` or when no channel shows unread. It works while
typing and yields to terminals and open dialogs. On a narrow layout, Escape that closes
the navigation drawer is consumed, so it never also marks anything read.
Feature-local details such as harness logs remain tied to their owning profile;
closing that profile or losing authorization also removes its log tab.
Right-click any channel tab and choose **Close all tabs** to close this channel's
thread, plugin and settings tabs across both panes, including hidden side-pane
tabs. The permanent channel conversation stays; focus returns there if its previous
target closed, while typing in surviving content remains uninterrupted. A
launcher's side panel, such as Todos, is not a tab, so it stays as it was:
shown in an open pane, or hidden in a closed one. Other channels and saved
message drafts are untouched. **Close other tabs** in the
same menu does the same, except that the right-clicked tab stays open, selected
and focused. On the channel conversation it is the same as Close all tabs. On a
detail tab, such as an agent log, the tab that owns it stays instead, without
its details.
A tab for another conversation, or for one of its threads, also offers
**Open in channel**, which opens that conversation in Channels; a thread opens
there at the same message, beside its root, which the channel timeline reveals
and marks even beyond its newest page. The current channel's own threads do not
offer it.
A thread that offers it also names its conversation above its original message,
as Inbox rows do (`#channel` or `DM · names`); that name is a link that does
the same.
Shift+F10 on a focused tab opens the same
menu. Hiding the pane remains separate from closing its tabs. It also hides a
launcher's side panel without closing it: the launcher reads pressed only while
the pane shows the panel, and one press brings back the pane with it.
The main-header split control toggles existing pane content without closing its
tabs or resetting their contents. With no content it is disabled but remains
focusable, so closing the last tab has a stable focus-return target. There is no
blank-tab creation action or channel/DM/tool picker. Tabs open from content such
as threads, profiles, channel settings and linked sessions. Todos and native
desktop Terminal remain available through their existing channel launchers;
closing a terminal presentation does not stop its plugin-owned shell.
Conversation tabs reuse the timeline, composer, draft and message-management owners;
selecting an already-open conversation selects its existing tab. Each main channel
keeps its own tab descriptors, selected tab, and pane visibility in memory for the
community session, including while visiting other pages such as Settings.
Changing the main channel unmounts its contents; returning restores those tabs and
saved conversation drafts without moving focus away from the main conversation.
A restored thread does not replay a previous Reply focus request. Feature-local
details such as logs close on that switch.
Changing session or losing a contribution retires the affected tabs and callbacks.
Tab sets are not persisted across application restarts. Opening a
detail from the main timeline still replaces the thread and transient details,
not retained channel-tool tabs. Content switches
immediately; the shared navigation selection background identifies the active tab.
Joined header separators meet the vertical dividers. The sidebar resize grip stays
visible throughout a drag while its tooltip stays hidden. Desktop main/secondary
dividers share that grip and support dragging, arrow keys (Shift for larger
steps), Home/End, and double-click to reset. Each page saves its chosen split on
this device, per community and viewer workspace like the sidebar width, so it
survives the panel closing, page switches, and restarts. While a companion is
open, the right column keeps the companion's one width, default, and minimum on
every page, including Messages; otherwise Messages keeps its own thread-panel
width. Reset clears the saved width. Widths clamp to the
available space. Narrow overlay layouts hide this divider and keep their normal
responsive sizing.

Pointer-opened secondary panels fade and slide in over 180ms with the shared
strong ease-out curve. Desktop panels travel 12px on entry and close immediately,
so the main view reclaims its width without waiting for an invisible exit. Overlays
travel their full width and exit over 120ms. Keyboard actions stay immediate;
reduced motion uses only a fade. Resizing remains immediate.
`features/panels/PanelDock` retains inert, accessibility-hidden closing content until
its CSS transitions finish, cancels stale cleanup on reopening, and leaves selection
and focus restoration with the existing owners. It adds no timer or resize observer.
Channels opts into the reusable companion prop and owns both cards, including a
companion-only view without a selected channel or relay. Settings and legacy
pages use the host fallback frame; opening from those pages does not navigate away.
The shell supplies the outer page gutter. Channel previews, roster labels, and routine refresh
and freshness indicators are omitted. Channel Settings → Diagnostics keeps
manual refresh, outbox inspection, and timing capture available on demand.
Background thread reads and sidebar enrichment/reconnection do not insert progress
rows into populated views. Initial empty loads still explain the wait; failures
and their retry controls remain visible.

The composer preserves the session's text sending and keyboard behavior. Its
rounded input and lavender send arrow follow the reference; unsupported upload,
mention, and rich-formatting actions are not presented as working controls.
Delivery renders like an ordinary message immediately. After ten seconds from the
message timestamp, unsuccessful/unconfirmed sends show a small notice. Confirmed
messages never show a success label. Retry remains available for failed/unknown
operations. `delivery.test.ts` covers the timing boundary and terminal states.

The shared conversation layer now supplies bounded thread reading/replies and
[session-owned unread indicators](unread.md). These are separate from this styling
pass: counts remain observed rather than exact, manual unread is local-only, and
reading intent belongs to reusable conversation UI rather than shell navigation.

Harness logs remain owned and authorized by the profile. `PanelSubview` presents
the log as a sibling tab in the channel pane, with standalone Back navigation
elsewhere. Closing the log or losing authorization unmounts it and stops its
polling; switching tabs retains it and the profile state.
Todos uses the standard 2.5rem header to align with other side panels.
