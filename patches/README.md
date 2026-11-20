# Virtua 0.54.2 scroll correction boundaries

The application imports the React ESM entry (`virtua` → `lib/index.js`) from
`src/features/messages/ChannelTimeline.tsx`. Only that entry is patched;
CommonJS and other-framework exports are untouched. Its store and element driver
carry the changes below. The scroll observer that entry shares with its window
and grid drivers carries the whole-edge rounding, the 1px absolute end path, the
scroll-end offset read and the momentum flag passed to the overflow callback;
the grid driver keeps its momentum-only overflow policy. Keep the dependency
pinned to 0.54.2 and review the patch plus version-coupled installed-bundle
tests before upgrading or adding a different import.

## Fractional end offsets

Text layout can produce fractional row heights. WebKit can truncate an absolute
scroll offset before clamping it, leaving the final row partly outside the
viewport even when Virtua requests the end of the list. A focused notification
target then correctly remains unread under the full-row visibility policy.

The element driver rounds end-boundary targets upward before RTL normalization,
for both imperative scrolling and automatic resize compensation. The browser
clamps that target to its actual scroll range. Interior reading offsets remain
fractional, and the existing scheduling, focus and dwell rules are unchanged.
Installed-driver regressions cover both entry points and RTL; a browser regression
sets a fractional list height explicitly and requires the final row to be fully
visible without a pixel tolerance.

## Buffer while the scroll direction is frozen

Virtua renders `bufferSize` only ahead of the scroll direction, and updates that
direction only during native scrolling. A shift (prepended history) or imperative
scroll freezes it until the 150ms inferred idle. Continuous trackpad flicks can
keep it frozen: a downward flick after an upward prepend renders no rows below the
viewport, and React commits one frame behind, so the leading edge stays blank for
the rest of the gesture. The range therefore buffers both sides while the
direction is frozen, as it already does when idle. Native directional buffering
is unchanged, and the extra buffer is no larger than the idle buffer.

A shift otherwise counts every row resize as an anchoring correction. Rows wholly
below the viewport are excluded, so a newly buffered row there that resizes (a
video loading, say) cannot move the reading position. Rows above and in the
viewport, including prepended history, are still corrected.

A flushed correction holds the mounted range until that correction's own scroll
event arrives. A correction that moves nothing, or that another write undoes in
the same task, raises no such event, so the held range outlived idle. In CI run
41120162311 (`history-loading.spec.mjs` "a held pointer keeps its place after
the page's reader row unmounts") Linux WebKit went idle after a 91px correction
with no buffer below the viewport, and a row just below it did not remount
before the test failed; the trace does not show which write left the
correction without its event. Scroll-end now releases the held range and
re-renders, so idle buffers both sides as above. Before that release, the
driver's scroll-end reads the native offset, as Virtua's viewport resize path does:
a jump whose scroll event trails the 150ms timer is consumed as its own event,
and the range is not re-rendered at the stale pre-jump offset. A correction
flushed after scroll-end with no later scroll event still holds its range until
the next one.

In an isolated WKWebView over real channel history (images, video, live relay),
fast alternating flicks were measured per frame. In two instrumented runs, all 46
DOM-coverage gap frames moved downward while shift mode held an upward direction.
Stock showed 3–96 gap frames per run over ten runs; the patch showed none in six.
Short main-thread stalls and image decode dips remain.

## Failure and chosen boundary

In a system WKWebView, native momentum can overwrite an instant programmatic
scroll correction. An isolated reproduction adapted from
[WebKit 262287](https://bugs.webkit.org/show_bug.cgi?id=262287) sustains missing
pixels even after DOM geometry covers the viewport. The same failure reproduces
with the production ChannelTimeline and fixed messages when history is prepended.
This does not attribute every disappearing-content incident to this mechanism.

The previous Mac deferred-store/extent patch is **superseded**. A pause in native
momentum can outlast Virtua's 150ms inferred-idle timer: the deferred correction
then runs before native momentum actually ends, and the timeline stays blank.
One of two paused draft trials failed; this was timing-dependent, not a
universally failing sequence. Increasing an idle timeout is not the remedy.

Instead, at each **nonzero automatic correction** on Mac WebKit:

1. Temporarily set only the corrected overflow axis to `hidden !important`.
2. Apply Virtua's original relative correction or absolute edge target.
3. Restore the prior declaration value and priority in the next task.

This extends the mechanism already used by
[Virtua's iOS driver](https://github.com/inokawa/virtua/blob/0.54.2/src/core/driver.ts#L533-L545),
without changing the iOS branch. Overlapping interventions cancel/restore their
predecessor before capturing the original declaration. Disposal restores
immediately; an observably changed later declaration is not overwritten.

**Tradeoff:** a correction can stop the remaining trackpad coast. Several size
corrections can therefore reduce inertial travel more than one prepend. A fresh
gesture must continue to work; sustained real-history/media acceptance must assess
whether repeated braking is acceptable. No wheel ownership, permanent scrolling
CSS, forced layout, alternate store sizing, or new scroll scheduler is introduced.

The `overflow-y: hidden` frame also removes a classic, space-taking scrollbar.
Every scroller driven by the patched Virtualizer on Mac WebKit must therefore
keep a constant inline size across the toggle (`scrollbar-gutter: stable`, as
`.feed` in `src/features/messages/Messages.module.css` does). Otherwise the wider
content box re-wraps rows above the viewport, their new heights become the next
nonzero correction, and the interrupt feeds itself until the scroller oscillates
between two wrap widths.

The momentum-interruption predicate requires MacIntel and Apple vendor, excluding
Virtua's iOS detector (including desktop-mode iPad). Chrome/Firefox, non-Mac WebKit
and iOS keep existing momentum policy. Store/layout timing and imperative smooth/instant target calculation remain stock.
The cancellation boundary below retires superseded targets. Scheduler-driven
reveal/restore/bottom navigation is a
separate acceptance path, not implicitly repaired by the automatic-correction fix.
Native reveal controls showed one/two transient blank interior source frames
before immediate recovery, despite valid sampled DOM coverage. This remaining
imperative-path flicker is not the sustained automatic-correction failure; the
patch does not claim to fix it.
The stale source-map directive is removed because the generated map is unpatched.

## Newer reader input cancels retained navigation

Virtua retains imperative targets for late measurements for 150 ms. After a jump
to latest, new upward input could detach the reader, but a row measurement inside
that window replayed the old target and pulled them back down. The element driver
now invokes its existing cancellation closure on wheel, touchmove, keydown and
pointerdown, matching ChannelTimeline's reader-intent events. Capture listeners
retire the old command before a descendant handler can issue new navigation;
no input is prevented and automatic resize compensation is unchanged. Disposal
also cancels retained work and removes the listeners.

Installed-driver tests keep the clock inside the pending command's lifetime,
including a replay already queued as a microtask, and verify a fresh navigation
still responds to measurements. The browser navigation case exercises real wheel
input and late row growth, asserting position as well as arrival count. These are
not native momentum/compositor acceptance, and do not change the limits above.

Cancellation stays owned by those native capture listeners; the timeline does not
need a second imperative cancellation API. The installed-driver controls cover
all four input events plus already-queued replays and disposal/remount.

## Corrections after a browser clamp

When rows above the viewport shrink, the automatic correction moves the offset
by the same amount. Stock Virtua applies it relatively unless the target reaches
the end, but the layout that `scrollBy` forces clamps an offset beyond the new
end first, so the shrink lands twice: once from the clamp, once from the
correction. WebKit reports an integer `scrollTop`, which reads up to 1px short
of a fractional end, so a reader at the bottom missed the end test there while
Chromium's fractional offset met it.

Since 0.52.8 ([#984](https://github.com/inokawa/virtua/pull/984)) Virtua takes
the absolute path when the last observed offset is at or beyond the new end,
scrolling to the exact target. The patch also takes it when the target lies
within 1px of the end, rounding outward as before. Interior
corrections, growth and prepend shifts stay relative. The installed-driver
regressions clamp the fake viewport like a browser and cover an integer offset
at a fractional end and a shrink larger than the reader's gap to the end.
`ChannelTimeline` treats an upward offset that arrives with a shrink as reader
input only after a gesture; while following, it re-pins the bottom instead of
demoting to Jump-to-latest.

## A shift outlives a late measurement frame

While older rows are being prepended (`shift`), the store compensates every
resize so the reader keeps their distance from the end, and it ends the shift
from its scroll-end timer, 150 ms after the shift jump's own scroll event. The
prepended rows are measured in the frame after that jump, together with the
former first row, which the same render re-laid out as a continuation without
its day divider and author header. When that frame runs late, the timer fires
first and the batch meets native policy, which keeps the viewport start: the
former first row sits at that start, so its shrink is dropped, and so is the
growth of a prepended row whose estimated bottom WebKit's integer `scrollTop`
reads short of. A reader at the top of history who loaded older messages saw
their content move about 76 px on Linux WebKit.

The store counts the rows a shift prepends and, at scroll-end, keeps shift
policy while any of them inside the rendered range is still unmeasured; the
resize batch that measures them ends the shift. A shift whose prepended rows
are not mounted ends at scroll-end as before, a batch inside the window is
unchanged, and a visible row that grows after the shift (an image loading)
keeps the viewport start as before. Installed-store regressions cover the late
batch, unrelated/partial batches before completion, the stock window and an
unmounted prepend.

## A page that lands before a correction's scroll event

After the store flushes a jump (a shift or a resize correction), it keeps the
last rendered range until that jump's own scroll event arrives, so the frame in
between cannot render from a scroll offset the DOM has already left. That range
is a pair of item indices. When the next page of older history lands inside that
window, which continuous paging makes common since corrections flush almost
every frame, its prepend moves every mounted row by the page size and the held
range now names the wrong rows: the render mounts the whole new page above the
viewport and unmounts the rows just below it, and the jump's scroll event
mounts those again one frame later. Measured in Chromium on the 640-row
fixture, each such page mounted and unmounted 20 rows in its own task and
remounted 20 in the scroll handler, 50–80 ms frames; the pages that landed with
no pending jump cost a few milliseconds.

The store moves the held range by the shift's item delta, so the rows it kept
mounted stay mounted and the scroll event's live range is computed as before.
A shift can also remove rows from the head, since the timeline reports one
whenever rows above the reader change and the rows from their first visible
row to the end do not; a removal past the held range's start would move the
range above the list, so it then holds the same number of rows from the top
instead. A partial removal holds a range wider
than the live one for that frame; a removal of every held row, which would
otherwise leave an inverted range that renders no row, lands with the
corrected offset at the top. Nothing changes when no jump is pending, for
appends, or for the correction itself. The installed-store regressions hold a
correction's range across a second prepend and across such a removal, and
require the live range that follows to lie inside it.

## Row sizes are delivered in the observer callback

Virtua renders an unmeasured row with `visibility: hidden`. Rendering from a
native ResizeObserver callback can mount rows the browser cannot observe in the
same frame, which WebKit reports as "ResizeObserver loop completed with
undelivered notifications". Since 0.54.0
([#952](https://github.com/inokawa/virtua/pull/952)) Virtua defers only the
`observe()` call for an element mounted during delivery outside the delivering
targets, and applies sizes in the callback. The previous patch deferred every
row size to the next frame instead; a newly mounted row then painted blank or at
its estimate for a frame, so a channel entered without saved geometry painted an
empty timeline and a row appended below a reader at the bottom overlapped the
rows above it. That deferral, and the immediate viewport delivery and first-mount
measurement built around it, are removed. Since 0.53.6
([#1039](https://github.com/inokawa/virtua/pull/1039)) Virtua also reads the
native offset before applying a viewport resize, which the patch previously
added. `membership.spec.mjs` checks painted frames for a revisit without saved
geometry and a late notice at the bottom, and its journeys fail on any
observer-loop error once Messages is ready.

Sizes delivered per callback can flush a second correction in the same task as
the first, before the first jump's scroll event updates the store's offset. The
absolute path, and its test for an offset beyond the new end, then started from
an offset that omitted the first jump. In Chromium, a page landing among the
loaded rows moved the reader about 220px in 2–3 of 20 runs of
`history-loading.spec.mjs` "keeps a reader 250px up". The scroll observer now
adds the jumps it applied since the store last observed an offset. It does not
use the native offset, because a browser clamp after a shrink must not land
twice (see [Corrections after a browser clamp](#corrections-after-a-browser-clamp)).
Installed-driver regressions flush a shrink above the viewport, and a shrink
after a clamp, before the previous jump's scroll event.

Per-callback sizes also split one page's measurements into several fractional
jumps. WebKit's integer scroll offset floors each one, so a reader in Linux
WebKit drifted about 1px per correction (4px across one page in
`history-loading.spec.mjs` "a held pointer scrolls across the page"). While the
native offset is still within 1px of where the last correction landed, the next
correction continues from that exact target instead. Any other movement,
including a clamp or reader input, uses the stored offset as above. An
installed-driver regression applies three 0.75px jumps on an integer offset.

## Automated checks

```sh
bin/pnpm install --frozen-lockfile
bin/pnpm typecheck
bin/pnpm exec vitest run src/features/messages/virtua-compensation.test.mjs \
  src/features/messages/ChannelTimeline.test.tsx
bin/pnpm test:browser history-loading.spec.mjs image-scroll.spec.mjs initial-position.spec.mjs membership.spec.mjs \
  --project chromium --project webkit --no-deps --workers=1
```

The driver/store/observer contracts evaluate the installed React ESM, not a
copied implementation. They cover active and inferred-idle corrections, zero
jumps, positive/negative measurements, absolute edges, horizontal RTL, overlapping
restoration, CSS priority, disposal/remount, later declarations, platform controls,
and unchanged imperative instant/smooth calls. Copied-bundle mutation controls
must fail when the production invocation, overlap/dispose restoration, priority,
or iPad exclusion is removed, or an inferred-scrolling gate is introduced.
These tests use a fake viewport; they cannot establish native painted pixels.

## Native acceptance and limits

Use an isolated system WKWebView, fixed data, no live identity, and phase-bearing
native wheel/momentum input confined to that window. Freeze/hash the source,
installed bundle and runner before each run. Start with a settled production
ChannelTimeline, prepend during momentum, then repeat with a pause longer than
150ms before the final momentum event. Compare stock, the superseded draft, and
the replacement. Capture source video frames separately from DOM/anchor traces.

Require both painted content and the correct identified reading anchor. Repeat
with a fresh reversed gesture, a second prepend at the bottom, a fresh upward
gesture, positive/negative row measurement changes, and explicitly gated local
images. Check restoration and continued movement, not just final scrollTop.
Exercise imperative reveal/restore/bottom controls separately. A pending image
placeholder and bottom rubberband/fractional edge gaps are not missing tiles.

Observed on macOS 26.6.2: stock and a paused old-draft trial sustain blank message
pixels; the replacement preserves content and correction anchors in the matched
native trials. Repeated native gestures and local images continue to paint, with
the braking tradeoff above. Ordinary Chromium/WebKit browser history, image and
initial-position journeys provide additional behavioral coverage, **not equivalent
native momentum/compositor evidence**.

The fixed-data native fixture does not fetch real older history. Three-second
movies are not four seconds of pixel evidence just because DOM traces run longer;
movie and JavaScript clocks are not synchronized. These bounded results are not
signed-package/cross-platform acceptance or verification of the original user's
sustained real-message incident. Keep the change draft until that acceptance is
completed; do not restart a running app without coordination.


## Base UI 1.8.0: native choice reset

`@base-ui__react@1.8.0.patch` adds native form-reset listeners to Checkbox.Root
and Radio.Root, with RadioGroup supplying its existing state reset, in their
shipped ESM and CommonJS modules. Without it, resetting
an uncontrolled choice restores the hidden native input but leaves Base UI's
visible checked state unchanged. The shared Buzz wrappers continue to delegate
choice state, keyboard handling and form participation to Base UI.

The listeners run in the next task, after native reset and ancestor cancellation;
a microtask can run before the browser completes its default reset action. Each actual
input owns its `form` binding, including external `form=` associations, disabled
radios and radios mounted after their group. Cleanup prevents queued work after
unmount. The group retains its existing uncontrolled state setter; repeated
radio notifications are idempotent. Controlled values remain with the caller,
and each hidden input restores its current checked state if the owner leaves
that value unchanged. Stable callbacks read the latest values when the owner
updates them during reset. No synthetic change event or ordinary change callback
is emitted. No other primitives are patched.

Remove the patch when a pinned Base UI release passes the reset regressions in
`src/shared/design-system/ui/controls.test.tsx` and the design viewer's native
reset browser check without it. A frozen install must reproduce the patch:

```sh
bin/pnpm install --frozen-lockfile
bin/pnpm exec vitest run src/shared/design-system/ui/controls.test.tsx
bin/pnpm design:test:browser
```

## Base UI 1.9.0: preview cards wait for a resting pointer

The same patch makes PreviewCard.Trigger's hover open delay a rest delay, as
Base UI's Tooltip.Trigger already does: the timer starts when the pointer stops
on the trigger and restarts whenever it moves, so a pointer crossing an avatar
on its way elsewhere opens nothing. Focus opens at once, as it does for
Tooltip, so the delay is only the pointer's rest; a zero delay still opens on
entry. Close timing is unchanged. The shared value lives in
`src/shared/design-system/ui/hoverIntent.ts`.

Remove this part when a pinned Base UI release rests before opening a preview
card; `src/shared/design-system/ui/Tooltip.test.tsx` covers it.


## Reader movement during height reconciliation

The element driver's automatic correction emits a synchronous, non-bubbling
`virtua-scroll-correction` event with normalized native `before` and `after`
offsets. ChannelTimeline's existing anchor hold uses this boundary to distinguish
reader movement from layout correction, even when the browser coalesces both into
one scroll event. The notification adds no scrolling policy or scheduler. The
hold consumes reader movement before reconciling list height and rebases after its
own correction; browser range clamping remains layout movement. Mounted regressions
cover both model/DOM orderings and coalesced movement, while installed-driver tests
verify actual offsets, including fractional clamping.

## dnd-kit core 6.3.1: stable idle transform

`DndContext` passes its drag transform as `ActiveDraggableContext`'s value and
rebuilds that object on every render, even with no drag. The sidebar renders its
`DndContext` whenever channel state changes, so each live message changed the
context value, and React searched the whole sidebar subtree for consumers. The
patch keeps the previous transform object while its four numbers are unchanged.
A drag still publishes each new transform; only identity of an equal value is
kept. Only the ESM entry, which the application imports, is patched.
