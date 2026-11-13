# Profiles: viewing public identities

The bundled `buzz.profiles` plugin supplies a profile panel for any
public identity, human or agent. It uses the current session's shared profile
directory. It is read-only for people and for other users' agents; profile
metadata and agent hints grant no authority.

For an agent this app keeps, the panel also shows its type's tabs and
the app's Delete action, from `features/agents` (`useAgent`, `agentSections`).
Its settings, attention and identity are edited there or on the Agents page;
Profiles adds no second editor, runtime view or process control.

## Display names

Kind-0 display names and handles are trimmed at the shared profile projection.
Names containing control, line/paragraph separator, bidi-control, or interlinear
annotation characters (U+FFF9–U+FFFB) fall back to a safe handle or the public-key
fragment. Script joiners and variation selectors remain in displayed names,
including Persian ZWNJ and ideographic variation sequences. Signed profile events
are retained unchanged.

Verified-name collision comparisons also ignore default-ignorable characters
on both sides, then trim whitespace, so a hidden character or visually inert
emoji selector cannot avoid the public-key suffix. This comparison can
conservatively qualify visually different names. It does not provide
general Unicode confusable detection: canonical-equivalent accents and repeated
interior whitespace retain the existing naming policy. Names never replace keys
as identity or authorization evidence.

## Agent activity

Opening an agent's activity (`buzz:profile?agent=<key>&tab=activity`, from a
message's activity bubble, a working indicator, a channel popover or a message's
**View activity**) opens its profile on its type's Activity tab: the agent's
sessions and their transcripts (see [Agents](agents.md#agent-types-and-providers)).
An agent whose type has no Activity tab, or one this app does not keep, opens on
its first tab. Profiles show no activity preview and host no separate activity
panel.

## Agent identity

For an identity with an agent hint (below), the Info tab adds a **Managed by**
row, matching Buzz desktop. It shows only a verified owner and is otherwise
absent:

- The owner comes from the NIP-OA `auth` tag on the identity's own winning
  signature-verified kind 0 (newest `created_at`, lower id on ties). A
  session-owned `session.observe` view supplies that event: it merges live
  events, refreshes on reconnect and resets on purge. While that view is live,
  the profile directory's retained signed head also seeds that choice, so
  reopening the pane after cache eviction never accepts an older response than
  the profile the session already shows. The directory notifies subscribers
  when that head changes even if display fields do not, so a head restored
  from disk also updates the pane. Verification is bound to that exact event
  id, so an auth-only change or a lagging older read never keeps or restores a
  previous owner. It requires exactly one tag, owner ≠ agent, conditions
  evaluated against the event, and a valid BIP-340 signature over
  `nostr:agent-auth:<agent>:<conditions>`.
- The row shows the owner's name (`formatPublicKey` without a profile name),
  with "(you)" when the viewer is the owner. It opens the owner's profile in
  the same slot when the host can open it.
- A missing or invalid tag, a failed read, or no available view shows no row.
  Without a view nothing can signal an auth-only change, so the retained head is
  not trusted; reopening the profile retries. The existing `isAgent` shape
  check, avatar shape and this machine's agent list never supply an owner.

Public metadata follows base Buzz's profile order: **Public key**, **Managed by**,
**NIP-05**. The existing npub copy control keeps its exact value and feedback.
NIP-05 is a whole-row copy button, with hover/keyboard indicators, a 1.5-second
success check and base Buzz's copy feedback. It remains self-declared: the row
matches base Buzz without a verification claim or badge. Display/copy never
performs DNS verification. Ordinary human profiles have no agent fields.

## Boundaries

- Shared message UI recognizes author-avatar and byline-name targets and
  identity-bound mentions.
  Ordinary `canOpenLink` / `onOpenLink` props advertise availability and dispatch.
  Channels resolves active contributions at click time and owns the right slot.
- `nostr:npub…` is the exact public-key target, with no relay hint or authority.
  Opening uses the current community session, never another connection or cache.
- Message avatars use an app-local `buzz:agent-profile:<pubkey>` target when
  their existing display evidence identifies an agent, including kind-40002
  messages without profile metadata. This preserves the avatar shape and an
  unnamed **Unknown agent** heading. Other unnamed identities use `npub…xyz`.
  The full copyable public key and profile-read retry remain available.
  The navigation hint grants no ownership or native control and is not added
  to the shared agent directory. Only the panel boundary accepts it; public
  message links and composer tokens remain restricted to `nostr:npub…`.
  Public metadata and configured names still win.
- Display names bind only against the message's signed `p` keys, longest first.
  Unknown, ambiguous, untagged and incomplete names stay plain text. Code/link
  contexts are conservatively excluded on the full body, before URL rendering.
  This is not a Markdown parser or a notification change.
- Replacement edits remain readable but their mentions are not clickable: old
  Buzz can change body identity bindings without changing original recipients.
  The composer sends chips of different keys that share a name, ignoring
  case, as `@Name (<64-hex key>)`; that span binds to the signed key it names
  when the key carries `Name` in any case, and shows as that key's name. Any
  other qualified span stays literal. After Markdown image or file attachment removal, signed names in the
  remaining prose can bind beside the removed attachment, but a name crossing an
  interior removal seam stays plain text: stripping must not manufacture a name
  absent from the signed prose. If Markdown link repair changes a body with attachment seams, mentions
  remain unbound because the seam offsets no longer identify the repaired text.
  Image attachments and signed notification recipients are unchanged. Full
  edit-snapshot rendering compatibility is deliberately deferred.
- Disabling Profiles removes its panel and clickable affordances without changing
  prose, drafts, delivery or recipient intent. Re-enable does not reopen it.
- Profile enrichment in channels and threads remains a background batch. The
  panel fetches only its selected missing key, with explicit failure/missing retry.
  Community/session replacement disposes the old view. About and self-declared
  NIP-05 metadata stay in the existing bounded directory and follow
  replacements/removal.
- A profile replaces the existing thread/object slot, not a second parallel dock.
  Close/Escape returns focus to the original control, falling back to the stable
  originating thread control if opening the profile unmounted the thread.
## UI and iteration

Avatar, name, about, self-declared NIP-05 (not DNS-verified), exact copyable
npub. **Message** is offered for a
foreign profile when the session can start direct messages; as in New message,
a known agent qualifies only while it is one of this machine's agents in this
community (the Agents `LocalAgents` snapshot), rechecked on click. It opens (or reopens) the one-to-one DM through the session's direct-message operation and
navigates to the relay-confirmed channel in the scope captured at click time. A
confirmed open also clears that DM's local sidebar hide. The person's
self-published NIP-38 `general` status (kind 30315, emoji tag plus text) uses the
session's shared live status owner, including expiration and clear events.
A custom `:shortcode:` status saves its catalog image URL as the emoji tag's third
value (`["emoji", ":code:", url]`) so it renders without the viewer's catalog;
unicode keeps the two-value tag, and older two-value custom statuses use the
catalog. While the catalog loads, an unresolved shortcode reserves the emoji's
space. Once settled, sidebar rows, bylines and the editor's emoji button show the
default 💬. Rows and bylines keep the full status in their label and tooltip, and
the editor's button names the shortcode in its hint; tooltips and profiles show
the shortcode as status text.
Set or clear your own status from the top-right profile menu. When the community
accepts status updates, your own profile also opens the same editor from a button
above **Edit profile**: **Update status** when you have one, **Set a status** when
you don't. It saves to that profile's community, closes if the community or
identity changes, and returns focus to the button, whose label follows the result.
A status wider than the profile column ends in an ellipsis.
Shared design-system Avatar and Button use the host-loaded styles directly. The
profile content marks its `data-buzz-ui` boundary and uses shared heading/body/mono
roles; its stylesheet owns layout, not component overrides. No new theme owner,
second global reset or shell migration. Designers own later refinement.

Agent hints change avatar shape, not authority:

- Profiles, mentions, participants and membership avatars use squircles for
  self-declared `is_agent`/`isAgent` metadata or exact keys of this machine's
  agents; otherwise they use circles. Agents tiles always use squircles.
- Message authors also use these hints. An original kind-40002 envelope is enough
  on its own and keeps that treatment through edits.
- Avatars never fetch an agent list or scan telemetry for these hints.

None of these hints proves ownership or running state. One bundled SVG mask scales
across sizes and clips only artwork, leaving the profile button's focus ring intact.

Use the normal `bin/just desktop` or `bin/just web` workflow in the feature worktree
with the existing public live-mode pin; run only one dev target at a time.
## Evidence and remaining checks

`avatar-shapes.spec.mjs` covers painted pixels and focus across sizes, themes and
viewports in Chromium/WebKit, including the artwork inside participant/membership
overlap borders (pictures and initials). Shape attributes alone do not prove that
inset artwork is clipped. Completion tests cover loaded-library changes without
another keystroke; profile-directory tests cover marker-only updates.

`tests/browser/profiles.spec.mjs` runs real React/ChannelsPage, thread reading,
profile directory, panel registry and plugin lifecycle against a synthetic
transport. It covers avatar/mention keys, keyboard/focus, disable/re-enable,
thread-only mention enrichment, failure/retry and session replacement in Chromium
and WebKit. It also checks copy success/failure with a stubbed clipboard and
light/dark layout at 390, 900 and 1280px widths. It does not establish an OS
clipboard, live relay or native packaging result. `profiles-appearance.spec.mjs`
additionally exercises the compiled app and host appearance owner: shared type,
color, compact-button styling, keyboard-only focus and single-scaled typography
at narrow, intermediate and wide widths in both modes.

Focused tests cover target validation, mention ambiguity/code/link boundaries,
signed-event → fold → renderer indentation preservation, current-body edit
marking, about-only profile updates, rendering and actual bundled registration.
The CI repair also narrows channel catch-up cancellation to top-level timeline
heads: `live-session.test.ts` forces overlapping unread reads for 1, 2 and 130
channels; `sidebar-unread.spec.mjs` holds unread evidence through real EOSE and
checks its badges without retries. Access-loss/disconnect cancellation is unchanged.
Broad scan and native build/package acceptance remain deferred to an agreed
integration batch.
## Info and channels

The profile's Channels tab uses the current viewer's `session.channels`
list and exact `ChannelSummary.members` from relay-authored rosters. It excludes
archived, hidden, DM and session conversations. Only positively identified stream
and forum rows render; when a matching roster lacks a recognized type, that
membership is unclassified and omitted from the channel rows. Ready empty copy
qualifies this uncertainty for the viewed identity, including partial lists.
Verified classified rows remain visible
alongside a transient list error; loading/error/partial discovery is not an
empty membership claim; retry uses `refreshList`. Rows navigate using the existing
scoped conversation destination when a valid community scope and navigation
capability exist, otherwise remain plain text.
