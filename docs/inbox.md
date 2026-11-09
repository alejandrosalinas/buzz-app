# Activity (Inbox plugin): in-progress port

Activity is a bundled page (`buzz.inbox/inbox`) that opens recent conversations
for the selected community. People see it as **Activity**, with the bell icon;
it was called Inbox, and its plugin id (`buzz.inbox`), page id and route
(`inbox`), saved-view keys and source files keep that name. Older sections
below say Inbox for the same page. The stacked evidence, conversation UI and Drafts
PRs are one user-approved Inbox launch batch; none should ship independently.
Activity no longer has a Drafts view (see [Drafts](#drafts-removed)); sections
that describe it are history.

## Evidence slice (stacked with Inbox UI)

PR3 added no Inbox UI. This page uses `session.unread.inbox()` as its single
conversation projection and `session.inboxFeed` as bounded addressed history
demand. These changes are one launch batch, not a separately shippable
backend feature. Ordinary channel and thread readers, read-state storage and
outbox retain their existing ownership. No projects, approvals or reminders.

## Conversation UI (PR4; Drafts in PR5)

### Toolbar and Mark as read

The Activity toolbar shows underline tabs sized to their labels, like Slack's Activity tabs, for the activity types (All, Threads, Mentions, DMs, Reactions). A **From** menu follows the tabs about a tab gap after Reactions, as part of the same group, and a labelled **Unread** switch follows From, so it stays in view on a wide page. The first tab's label starts on the same edge as the bell in the title bar above, and the tabs, From and Unread share one text baseline. From's button says only "From" with a chevron; its accessible name and tooltip say the choice in words ("From anyone", "From people", "From agents"), and it shows the shared subtle fill while People or Agents narrows the list (ghost, with no fill, for Anyone). Its menu is one plain-text choice of Anyone, People or Agents. Activity, sender and attention choices are saved on this device for the current account and community, with each missing or invalid choice using its own default; earlier saved sender values load unchanged, and a saved choice from the retired Archived view loads as the normal All list. The whole toolbar stays on one row at typical widths, including a 540px list. Narrower, Unread wraps first, to the start of the next line under All; narrower still, From wraps too and starts that line, with Unread after it. The refresh status fills the space after Unread, so it never adds a line.

Activity has no Archive: every admitted conversation stays in the list, and the Unread switch narrows it to what is still unread, as in Slack's Activity view. **Mark as read** (✓) appears on unread rows that can be read, on hover or keyboard focus over the row's time, and remains visible without a hover pointer; read rows show only their time. The row context menu offers **Mark as read** and **Mark unread**. Mark as read uses the same explicit read as selecting an unread row; if it fails, the row stays unread with Retry. Row actions never open an unselected conversation, and no other conversation is opened or marked read.

With Unread off, a read row stays in place and stops being bold; if its ✓ held focus, focus moves to the row. With Unread on, it leaves the list and a notice ("Marked as read") offers **Undo**, which marks it unread again on this device; Undo does not rewind read state saved for other devices or later reading. The open conversation stays: its reader, scroll position and composer draft stay where they were, and under Unread its row remains while it is selected. If the row that left, or its menu, held focus, focus moves to the next visible row (or the preceding one at the end), or to From when none remain. Focus in the reader or composer stays put.

When Unread leaves All activity from anyone empty, the list says **All caught up** and offers **Show all**, which turns Unread off. Otherwise, when a type, From or Unread choice leaves the list empty, **Clear filters** resets those three. Either returns focus to From. Sending a reply does not change the list; Activity reuses the unchanged shared composer. Filter and selection policy lives entirely in the Inbox plugin, over the shared unread evidence owner's `session.unread.inbox()` projection. Archive records saved by earlier builds are no longer read; removing their storage module is a follow-up.

Inbox now renders chat-only DMs, Solo conversations, mentions and participating threads through
`session.unread.inbox()`, with independent Activity type and Sender filters and
an independent Unread switch. Sender classification uses `session.agentChoices` and
cached/profile-backed identity evidence, never a new inventory or name heuristic.
The Mentions activity filter uses explicit mention messages for each conversation's preview, sender, ordering, resume point and unread count. A later ordinary reply does not make a read mention unread again. DMs remain direct activity rather than mentions merely because their recipient is tagged. All activity and Threads retain their conversation-wide projections. A row shows its newest message and sender, matching its time, while opening it still resumes at the oldest unread message. A Solo chat's top-level row shows the newest top-level message from anyone else, and is ordered by it. It skips messages addressed only to agents and roots that have their own thread row.
Rows retain exact IDs and current names while `inboxFeed.incomplete` marks only specific group members awaiting their stored edit/deletion closure. Those rows say “Preview updating…” or “Preview unavailable. Retry activity.”; other rows stay usable. This is a visible completeness warning, not a guarantee that the relay did not change after verification. A failed read exposes Retry above the list. Retry stays focusable while pending; successful recovery returns focus to the filters only if Retry still owned focus when its alert was removed.

The list is the Inbox page's first tab, in the host tab workspace behind `conversation.ui.Tabs`. Opening a row shows its conversation beside the list in the side tab pane, with the same reader and composer as Channels tabs: a thread at its exact message, revealed even outside the newest bounded page, or a whole DM or session conversation where its Channels tab would open. A DM row opens as a thread at its resume message only when that thread holds all of the row's unread messages, or, with none unread, when it resumes at a reply. Otherwise it opens whole, where threads show their reply counts. A DM thread's reads, on the row's click and in its later dwells (including in a tab restored on returning to Activity), cover the DM only through the newest message this device has received, and stop just before its earliest unread message outside that thread (a top-level message or a reply in another thread). So a message outside the thread that was received before the read stays unread, even one received after the row last rendered. A DM's read state is one point in time, so the thread's replies from that message on stay unread too, until the whole DM is read; meanwhile the row opens the whole DM. A message outside the thread received only after a thread read, but dated at or before what that read covered (sender clock skew, a message sent in the same second as a thread reply, or an outbox retry that keeps its original time), is read without being shown. A whole DM opened from its row reads through the click time, as a channel's explicit read does. A plain open replaces the tab the previous one added, so one tab follows the selection; a tab moved to the main pane stays. The tab's right-click menu offers Open in channel, which opens its conversation in Channels; a thread opens there at the same message, beside its root, which the channel timeline reveals and marks even beyond its newest page. A thread also names its conversation above its original message, as the rows do (`#channel` or `DM · names`); that name is a link that does the same. The pane resizes, closes and handles Escape as Channels' does. Returning to Activity in the same session, through Back or the sidebar, restores the list's scroll position once it shows, unless it has already been scrolled, and brings the selected row back into view if it was visible on leaving and has since moved out of view; a relaunch starts at the top. A filter change keeps the list's current position: an empty list that the change fills stays at the top. A late verified root can regroup a conversation without changing its open tab. Inbox tabs do not enter a channel visit, so showing one preserves forced-unread intent. Reading is saved by the shared unread owner, through the reader's dwell and the row's explicit read. A Solo chat's top-level row reads in one save, as its live bottom does: the channel catch-up mark reads its ordinary responses, and mentions are read individually, so its thread rows stay unread. As in a plain channel visit, the visible selected side tab reads while focus stays anywhere on the page, such as on the row that opened it; a tab moved to the main pane reads only by its own focus. Unlike a restored Channels side tab, an Inbox tab restored on returning to Inbox also reads, since it is still the selected conversation. Failed read actions retain their captured Retry unless access, the session or a newer intent retires it. A DM Retry reuses the original channel cutoff and manual-clear keys, not the retry-time clock or later arrivals. Re-clicking the selected row reselects its tab without repeating its read. Closing the tab ends the selection, so reopening the row reads it again. Archiving the selected conversation's channel, or its room becoming a Huddle, closes its tab and returns focus it held to the filters, and restoring the channel does not reopen it; other retained tabs follow Channels' unavailable placeholder, and focus their reader held moves to the tab. Re-clicking the selected row reveals its current message in its tab. A whole DM or session tab stays whole when its row regroups or reads into a thread; a thread tab follows its row, so a DM thread whose row no longer opens as a thread opens the whole DM. Context menus allow device-local Mark unread. Row accessible descriptions reuse the visible safe preview or incomplete placeholder; Show more follows the filtered result count. `NavigationItem` owns selected styling and `aria-current`. No Inbox-owned session, parallel fold, composer or outbox.

Solo chats include ordinary incoming top-level messages, excluding agent-only coordination and system events. Their flat rows appear under All, not DMs, matching the sidebar's separate Solo and Direct messages sections; nested threads stay separate. Reading in Channels or Inbox clears the same evidence.

### Open Activity with a filter

Four shortcuts ("Open unread in Activity" and so on) open the Activity page with its filters applied, including from the composer, like Slack's: ⌘⇧A (Ctrl+Shift+A elsewhere) opens All activity with Unread on, and ⌘⇧T, ⌘⇧M and ⌘⇧K open Threads, Mentions and DMs. Threads, Mentions and DMs keep the saved Unread choice; Sender is never changed. They are rebindable in Settings → Shortcuts. The shortcut opens `buzz.inbox/inbox` with a versioned route (`{ attention?, activity?, sender? }`) that the page validates, and a plain open from the app dock carries none and leaves saved filters alone. Omitted fields keep their saved choice. Plugins and `buzz://plugin?id=buzz.inbox&page=inbox&route.<key>=<value>` links use the same route. The page applies a route once per presentation of the visit, but not when Back/Forward returns to it, which keeps the filters as they were left, using the same saved choices as the toolbar, so pressing a shortcut again after changing the filters by hand applies it again, even though the host treats an identical address as the same history entry.

### Dock preview

Resting a pointer on the Activity bell in the app dock opens a card of recent
conversations through the page contract's `preview`. It reads the same `session.unread.inbox()`
and `session.inboxFeed` projection as the page, with All activity and Everyone,
newest first and bounded to 50 rows after mixing conversations and reactions, as on the
page. The header leads with the number of
unread conversations, then counts each once by its most specific kind: DM, then
mention, then thread. A mention counts only while it is unread, as Mentions with
Unread only would list it; a Solo chat's flat row has no kind, so only the total
counts it. Unread only is the card's own
choice, saved on this device per account and community, and never changes the
page's filters. A row opens its conversation directly, through the same
conversation target as the page's fallback, and closes the card without opening
Activity; reading follows the ordinary channel visit. **Open Activity** opens the page.
The shell hides the card while Activity is selected and on devices without hover.

## Drafts (removed)

Activity had a Drafts tab (PR5) that listed every saved composer draft in the
community. It was removed: a draft now stays only in the conversation where it
was written, and its composer restores it there as before. Composer draft
storage, sending and per-conversation attachment drafts are unchanged. Links made while Archived and Drafts
existed still open the page: a route's `show` is ignored, and `{ drafts: true }`
alone opens the saved filters. `listDraftViews` in `src/shared/view-state.ts` no longer
has a caller outside its own tests.

## Ownership and limits

`session.unread.inbox()` / `subscribeInbox()` own retained verified unread
evidence and read actions. `session.inboxFeed` owns finite, verified addressed
history demand and exact incomplete-target metadata, not a row cache. Finite
results and live arrivals, edits and deletions use the existing session admission
and shared unread fold, so own/deleted messages stay absent and unresolved roots
never become duplicate conversations. Current membership gates the feed's
completeness targets and unread's rows; joining alone does not materialize
pre-membership history without fresh shared admission. Inbox renders those shared
conversation rows directly; there is no second project/approval row merge or
feed-owned reconciliation buffer and deletion-count abort.

Channel-archived rooms are excluded from the shared Inbox projection in every
activity view. Signed archive/unarchive metadata invalidates that projection even
when membership and channel type stay unchanged. Archiving removes their rows and
closes a selected Inbox detail, without clearing retained evidence or read/local-unread
intent. Unarchiving makes retained conversations eligible again; it does not
reopen the detail. Ordinary Channels/search retain member history access and
archived posting restrictions. This is Inbox eligibility, not access revocation or
notification policy.

PR4 owns only presentation, filtering and selection. No parallel signing or persistence is
added. Optional profile enrichment belongs to PR4; access, cache clear and
session retirement fence these projections. Opening Inbox does not mark rows
read; selecting an unread row does. Canonical Messages keeps its own reading
behavior.

A DM is one conversation row, and so is a session's flat top-level timeline;
Inbox opens that session row in the channel reader. Elsewhere, including session
threads, each thread root or top-level message is its own row; a session message
whose replies are in Inbox stays with its thread.

DM read clears the channel through its newest retained evidence. Thread read
advances the thread prefix, including earlier unshown replies, plus individually
represented top-level mentions and local message marks, but not unrelated
messages. Participation follows the shared unread owner's direct-parent policy,
including its existing bounded lookups for replies whose membership is undecided.
Fetched roots and participation witnesses remain structural, never extra Inbox rows.
A lookup-only root uses the existing exact-message manual-unread target until counted
root evidence arrives; its known root still supplies grouping and read-through.
Relevant replies remain thread activity even when the root cannot be fetched.
Multiple steps are not atomic: failures leave remaining evidence retryable. Manual unread is local to this device. Hosts without frontier-sync
disable read mutations. Saved frontiers are not proof of remote reconciliation.

This is **bounded recent evidence**, not a complete historical inbox. Unread
retains at most 4,096 events / 8 MiB, observing up to 500 recent events per
128-channel roster batch. A lazy addressed query returns up to 50 kind-9/40002
messages. For those exact IDs and unresolved failed targets, general `#e`
queries page signed kind-40003 edits and kind-5/9005 deletions, then deletions
of the edits; `include_aux` on an ordinary `#p` query is not a supported relay
contract. Both auxiliary stages must finish before the feed is ready. Retained
unread evidence can be provisionally admitted between queries, but exact target
IDs are marked incomplete **before** unread subscribers are notified. The
consumer must not show their body as current while incomplete; failures retain
that metadata and offer retry. This is a completeness signal, not atomic content
admission or a second message fold. A target outside the latest 50 addressed
rows is not discovered; if a failed target falls outside a later page its
bounded auxiliary check still runs before its incomplete flag is cleared.
Incomplete obligations survive disconnect and unrelated access revocation while
the corresponding readable unread evidence survives; full cache/session retirement
clears both. Tombstone checks include retained author edits even if a later relay
query omits their soft-deleted rows. If reference visibility withholds an auxiliary
event, the finite attempt stays failed/incomplete rather than treating the filtered
page as exhausted history. Explicit Retry can settle it once existing shared
readers have admitted the missing reference; Inbox adds no reference-resolution loop.
Auxiliary reads cap retained results at 2,000 events / 4 MiB per stage; the shared reader
keeps its existing per-request deadline and cancellation. Missing roots,
participation or older activity can omit rows; an empty Inbox does not prove
complete history. No polling, independent row source or channel window is
opened for the feed. Access/cache/disconnect/disposal fence pending reads; local
read intent remains with unread. Packaged/native acceptance and human visual
feedback remain separate.

Reminders and their NIP-ER lifecycle are **not included** in this change.
The unfinished reminder prototype is preserved separately for later work,
not shipped in the Inbox source or broker routes. Follow/mute Inbox policy,
full backlog discovery and nonchat activity are outside this slice. Project and
approval queries, grouping, routing and detail presentation are deliberately
excluded rather than presented as partial parity. Native/ACP packaged acceptance and human visual feedback
remain open. Do not treat this as the full OG Inbox port.

## Split assertion ledger

The #422 source's 2,073-line mounted file has 38 literal `it` blocks plus
four parameterized groups (2 + 2 + 3 + 2 = 9 executions), totaling
**47 executed cases**. Fourteen literal Drafts cases moved intact to PR5's
`DraftsView.test.tsx`; PR4 owns the remaining 24 literal cases and all four
parameterized core groups. The original 47 = 24 core literals +
14 Drafts literals + 9 grouped core executions. PR4's 41 expanded test runs
at its published head comprise those 33 original core cases plus eight new
regressions. PR5 adds two Drafts deletion tests. PR3 retains the existing
unread suite and feed integration cases with historical edit/first-admission
safety regressions. `view-state.test.ts` adds five scoped enumeration and
meaningful-cap tests; `attachment-draft.test.tsx` adds pending/ready cleanup
regressions.
The mixed filter case keeps its two selector assertions in PR4; its Drafts
header-button assertion belongs to PR5's mounted Drafts suite. Source
project/todo/sidebar navigation tests already on main are not copied here.

Browser mapping: original case 1's chat/filter/context/read/reflow assertions
remain in PR4; its Drafts switch/return fragment lives in PR5's Drafts view test.
Original case 2 is PR5's real rich-editor/scroll/geometry/send journey. Original
strict-window case keeps exact unread anchor/new arrival/canonical origin/deletion
in PR4 and moves saved-root newest-context to PR5. Original old-DM, session
recipient and narrow failed-save cases stay in PR4. That is the original seven
browser cases split across PR4/PR5, plus PR4's new in-head focus and Escape
focus cases and development-React StrictMode case. The joined stack runs eight
cases in PR4 and two in PR5, each in Chromium and WebKit (20 executions total).
The fixture uses per-test isolated synthetic identities/servers, preserving the
base `channelWriteKinds`, `dmMembers`, companion and stale-stream guards.

The counts above are historical PR-head counts. A later test prune removed two
mounted cases whose assertions stronger cases already make: `InboxPage.test.tsx`
"Retry repeats a rejected mark-unread mutation, not just evidence refresh"
(kept by the failed mark-unread Retry cases) and `DraftsView.test.tsx` "a
selected draft edits through the shared scoped composer without navigating or
sending" (kept by the same-window editor, 128 KiB rich-editor and emptied-editor
cases). At that point `InboxPage.test.tsx` collected 61 cases and `DraftsView.test.tsx` 29;
both Drafts suites were later deleted with the Drafts view.

## Verification status

`inbox-feed.test.ts` exercises the real session reader/visibility/unread owners
with signed ephemeral events, including the first-admission subscriber ordering,
held edit and tombstone reads, failure/retry, reentrant access removal and cache
reset, root regrouping, and an edited addressed target older than 500 ordinary
messages. `unread.test.ts` retains the current main read/catch-up behavior and
adds Inbox projection/read-state cases. Neither file establishes browser paint,
real relay persistence or packaged/native acceptance. PR4's mounted real-session
`InboxPage.test.tsx` covers filters, read/retry and pending row/detail evidence.
`tests/browser/inbox.spec.mjs` uses the actual broker/browser in Chromium and
WebKit for exact focus, viewport/scroll, responsive failure recovery, canonical
origin and session-recipient publication. This is synthetic fixture evidence,
not human live or packaged acceptance. The Drafts view's suites
(`DraftsView.test.tsx`, `tests/browser/inbox-drafts.spec.mjs`) were deleted with
it; `view-state.test.ts` and `attachment-draft.test.tsx` still cover draft storage
and attachment cleanup.

### Review repairs, 2026-10-01

The uncommitted repair tree based on `9d3d43cf` passed 561 focused tests across
14 files, TypeScript, changed-file Biome, design checks and all 22 Inbox browser
executions in Chromium/WebKit. The browser total is now 11 cases per engine:
the prior ten plus one real two-page draft-storage journey. No cases were removed.
Existing native-focus cases now also cover selected-row re-click, empty-filter
focus fallback, and media Escape staying inside its portal before detail dismissal.
State/failure permutations remain in mounted React or the relay owners' tests.

The relay regressions failed before repair for both lifecycle paths, omitted
retained edits and withheld auxiliary pages. Separate advancing count/byte-limit
cases fail when their corresponding guard is removed. Mounted Drafts regressions
failed before repair for channel/thread post-send cleanup, external replacement
and a valid rich document crossing 128 KiB. The DM cutoff and cold Settings
fallback tests also fail when their repairs are reverted. An independent review
of the first dismissal fix caught a portal propagation defect; both browser engines
reproduced it before the DOM-containment guard and passed afterward.

Independent changed-path re-review found no remaining blockers in the repairs.
These are local fixture/service results, not checks on pushed PR heads or a future
merged tree. Human, live-relay and attended native/packaged acceptance remain open;
no full scan or shipping-readiness attestation is implied.


## Visual-only pass (#770)

Built on main's existing Inbox and Drafts: one filter menu, outline/filled unread
toggle, trailing unread dots, adjacent list/detail with one header, and the shared
centered draft-delete dialog. The list/detail divider reuses `usePanelSplit` and
`ResizeHandle`: drag, arrows (Shift for larger steps), Home/End and double-click
reset. The list defaults to 420px where space allows and can resize from 320px
up to a 50/50 split with the conversation, which keeps at least 316px.
Its chosen width is saved per community and viewer workspace, so it survives
detail close/reopen, Inbox/Drafts switching, visiting other pages, and restarts;
reset clears it. At ≤700px available width, detail replaces the list
and the divider is hidden.

All matching **already-loaded** Inbox rows render without Show more. Optional
profile enrichment remains bounded to the first 50 candidates; cached names still
apply, and uncached later names may keep key fallbacks. No new history demand,
profile loop, row cache, relay/session/unread/store or native changes.

Main retains loading, representative People/Agents filters, grouped Mentions,
selected-read visibility, read/retry, workflow attribution, thread follows, exact
readers and draft persistence. Deletion retains consent and text-before-attachment
cleanup. The former history/candidate/exact-mention work is excluded.

## Reaction activity

`session.inboxFeed.reactions` owns a separate bounded projection of recipient-tagged
kind-7 events. App and MCP writers add the target author's `p` tag. It recovers
50 recent addressed events and retains up to 100 candidates, including live arrivals;
it does not backfill legacy tagless reactions. Exact target ownership, current channel
eligibility and edit/deletion closure are checked before displaying any preview.
Incomplete settlement withholds rows and offers retry rather than showing stale text.

After filtering reactors, the page and hover preview group emoji used by multiple
people into one row per emoji and target (custom emoji include their URL). Emoji
used by only one person fold into that person's row for the target. Each row uses
its newest active reaction for time and ordering and counts distinct people.
Rows regroup after additions, removals or sender-filter changes. The page derives names
from the filtered reactors
and opens that message through the existing conversation navigator. Reactions have
no unread state, mark-read actions or badge contribution. Selecting Reactions turns
Unread off; All with Unread on excludes reactions. The hover preview mixes reactions
with conversations by time within its 50-row bound; its own Unread only switch hides reactions.
Reaction rows show reactor names and emoji, a one-line grey message preview, then
subtle “in <conversation>” context. Only names truncate in the heading. Solo and DM
reactions open the whole conversation at the message; thread replies open their thread,
using the same tab rules as message activity.

The shell shares one Activity emoji state across icon placements. The first eligible
live arrival holds for three seconds, ignores subsequent arrivals during the hold,
and fades back to the bell. History/replay never triggers it. Hidden windows skip it;
custom images must load within one second. Reduced motion removes scale. The icon
is decorative and preserves the Activity accessible name.
