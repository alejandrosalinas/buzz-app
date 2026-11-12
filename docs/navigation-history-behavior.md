# Navigation history behavior

Dialogs and content tabs follow the [navigation history and dismissal contract](navigation-history.md).
The integrated families are Members, Settings sections, provider controls opened
within Settings or through Agents-page links, agent config version inspectors,
and thread, Profile and GitHub tabs.

Plugin account-action dialogs in the profile menu are a documented exception.
They live in the profile menu's own state and create no visit: Back/Forward
leaves them as they are, and closing one adds or retires nothing. Moving them to
the navigation owner would change every account action at once. Focus's dialog
holds one short choice with no draft or pending work; other account actions,
such as Send feedback, can hold drafts and uploads.

Back/Forward revisits content and restores the selected thread while retaining
open tabs. X (and the equivalent explicit tab
close controls) removes the thread and retires its addressed visits. Traversal
skips those dismissed visits; Close does not add another visit that Back undoes.
Unrelated channel/message visits remain. A cold thread closes to its own channel
in place. Explicitly opening the same thread later creates a fresh visit.
Back/Forward returns a thread to where the reader left it in this window; only
a fresh opening, or a return to a place no longer loaded, reveals a linked
message again. If the channel's latest messages were evicted meanwhile, the
thread can briefly show its end before it returns to that place.
The same rule covers message links that open in the channel timeline rather
than in a thread: Back/Forward returns the timeline to where the reader left
it, whether it comes from another channel or from another link in the same
channel. Following the link again, Retry and opening the visit already shown
are fresh openings and reveal the message. The place Back returns to is also
where a later plain visit to that channel opens, with one exception: if a
reveal left the reader less than 80 px from the end, Back keeps the message
where the reveal placed it, but a plain visit opens at the latest message, as
it does after the reader scrolls that close to the end.

Profiles and GitHub use the same rule. Their read-only target and optional
thread context are carried as `detail` in the scoped conversation address;
Back/Forward restores selection and reload resolves the panel through the
existing registry. Plugins that specialize canonical profile targets and opt in with
`component.profileHistory = true` keep the same history behavior. Unmarked catch-all
panels retain their existing local behavior.
A new link replaces the transient Profile/GitHub detail;
opening a thread clears it. Replacement does not retire the earlier visit, so
Back/Forward can reconstruct it. Explicitly retained tabs keep their existing rules.
Replacing the live session within the same account/community reconstructs the
read-only address, including after deliberate same-community resets. Old panel
callbacks are revoked; local editors do not carry across sessions. A different
account/community scope clears the current detail address once known; a
temporarily unknown reconnect scope does not.
Thread/detail dismissal records survive same-scope session replacement, including
verified reply roots. Closing reconstructed content retires its earlier visits
as well as its current one; this does not carry layout or live panel objects.
An inactive X preserves the selected content while retiring the closed tab's
known visits. Other panel families keep their existing behavior. Navigation
does not recreate terminal sessions or change pane layout history. Close other
tabs and Close all tabs retire the complete set of closed content visits in one
navigation transaction, including inactive tabs. The kept tab stays selected;
underlying channel/message visits and other channel workspaces remain available.

Members follows the same rule: opening it adds a visit. Back closes it while
staying on the channel; Forward restores it. X, Escape and outside dismissal
retire that visit, so the next Back leaves the channel and
Forward keeps Members closed. A link handoff replaces the Members visit with
its destination when the channel opener is known; cold handoffs retain a channel
visit beneath the new destination.

Settings Close retires its known section visits for the same account/community
scope and returns to the covered workspace. Back/Forward between sections remains
reversible until Close. Back/Forward to Manage plugins reopens the plugin
details that visit showed; opening it from another section starts at the list.
Profile discard confirmation precedes dismissal and Back/Forward departure.
Keep editing preserves the mounted draft and current visit; Discard changes
continues the requested traversal without retiring the Settings visit.
Agents-page provider controls retire that provider's known visits on the same
scoped Agents page, preserving other providers and page visits. Their pending-work
close protection remains in the shared Dialog. Settings → Agent setup provider
controls get a nested Settings visit: Back closes the provider while leaving
Settings open, Forward restores it, and provider Close retires only its nested
visits. Closing Settings retires its sections and nested provider visits together.
Restoration opens controls, never an install, sign-in or save operation. This does
not add new history visits to every existing confirmation or editor.

Agent config version dialogs retain an expanded Previous versions list and its
scroll position underneath, in both the Agents page and owned-agent profiles.
Back returns to that list;
Forward restores the selected version using the current config store. Close,
Escape, outside dismissal and a confirmed revert retire that version's visits
within the same account/community scope. Restoring a dialog never submits a revert.
The shared Dialog blocks explicit dismissal during a revert; passive traversal
can hide it while the existing write continues. Completion retires its presentation
even after Back. A cold or reloaded address reloads history; Load older remains
available in the dialog if the selected revision is beyond the loaded page.

## History and lifetime boundaries

App arrows, supported history shortcuts, mouse Back/Forward buttons and, in
the macOS app, three-finger trackpad swipes (when Swipe between pages is set
to three fingers, or two or three fingers) use the same navigation driver.
Browsers retain their physical history entries; the driver
skips retired entries rather than claiming to delete arbitrary native history.
The app's traversal affordances account for those skipped entries. The managed
window is capped at 100 visits, including its persisted dismissal associations;
older return paths expire and their tab metadata is pruned. Dismissal
indices are kept in sessionStorage for the browser chain; open tabs themselves
retain their existing community-session lifetime. After reload the driver knows
the current visit and its immediate opener. Older visits not revisited since
reload may remain reachable after closing the same content; workspace restoration
across refresh is separate from this behavior.

## Evidence boundaries

Colocated tests cover driver traversal, inactive dismissal, cold targets, verified
thread roots and navigation-attempt lifetime. The browser regression files prove
actual popstate/hashchange traversal, X and two-tab behavior, and the reading
place of linked threads and channel timelines, in the production components
with the existing disposable relay fixture. They do not establish
native desktop acceptance. Manual comparison and acceptance steps are recorded
in the pull request description.
