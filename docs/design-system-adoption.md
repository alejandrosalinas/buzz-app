# Shared design system adoption

Buzz uses shared semantic colors, Inter and JetBrains Mono, and Base UI interaction
primitives. Buzz owns the visual direction of its controls and states. Public
fonts, packages, and generic examples keep the system independent of private assets.

Use this map to find the shared owner before changing a product surface.

## Shared owners and app uses

| Area | Shared owner | App uses |
| --- | --- | --- |
| Colors and type | Surface, text, border, affordance, and complete type roles | Host aliases forward to shared roles. Feature CSS uses role names; inline links pair text and hover roles. |
| Actions | Button and IconButton | Retry, refresh, delete, recovery, composer send, and picker triggers. Standard sizes are 32/40/52px; IconButton defaults to small and labelled Button defaults to medium. Text-button heights are minimums. Labels stay on one line; surrounding layouts reflow whole controls or scroll. |
| Forms and choices | Field, Input, Textarea, RadioGroup, Checkbox | Profile, community setup, appearance, plugin import, and workflow editing. |
| Search | SearchField | Channels, pages, members, and GIFs retain their query, refs, and keyboard handlers. |
| Navigation | SidebarNavigation composing NavigationItem and NavigationSection | The primary sidebar and Settings consume the same component, preserving main’s compact sidebar appearance. Features retain unread, collapsing, dragging and scrollbar geometry. Other shell destinations and community choices retain their existing treatment. Route destinations use button semantics; the shell side dock is the documented shell-tab exception. |
| Tabs | Tabs | The shell side dock links retained page panels and preserves tab focus on selection. Emoji/GIF connects tabs to panels with Base UI keyboard activation. Workflow mode keeps its feature-owned editor view. |
| Modals | Dialog and AlertDialog | Use the [modal composition](../src/shared/design-system/DESIGN.md#modal-composition): shared title/description lockup, normalized sizes, secondary Close, and fixed footer gutter outside scrolling content. Page search, community setup, and workflow confirmations retain their dismissal and focus contracts. |
| Panels and headers | Panel and PanelHeader | Settings, channels, and companion cards share appearance. Features own grids, scrolling, docks, and subscriptions. |
| Read loading | LoadingRegion | Profile Settings uses a same-scope verified snapshot while refreshing; cold reads reserve the actual form geometry. Delayed status does not delay results, errors, or write feedback. |
| Feedback | Toast (Sonner) | Sidebar preferences and Settings recovery use the shared bottom-right Sonner stack with source-owned recovery. Completed-action feedback can outlive its row. Relay connection recovery is one quiet bottom-right notice on every page, and the stack rises above docked composers (`useToastClearance`), while channel live-update failures that recovery does not retry stay inline above the composer; form errors, blocked pages, and lasting paused-state context stay inline. |
| Hints | Tooltip | Control hints and agent activity support keyboard access and dismissal. Controls keep their own accessible names. |
| Solo chats and activity | NavigationItem, Button, IconButton, Panel, PanelHeader | Solo chat history, agent choice, and activity actions retain unread, admission, draft, and focus behavior. Base UI owns their menus. |
| Media stages | `surface-inverse` and `text-inverse` | Preserve the stage’s existing values and measure text pairings. Renderers own image and video pixels. |

## What stays with the feature

Shared appearance does not transfer ownership of product data or interaction.

- **Rich editor:** caret, IME, selection, and completion logic stay with the editor. Completion rows keep `aria-activedescendant` while using shared colors and type.
- **Media:** GIF and image tiles retain native selection buttons and geometry. Search, retry, playback, and zoom actions use shared controls. Image zoom uses a native range with semantic colors; there is no shared Slider. The renderer owns modal focus, drag regions, playback, and timecodes.
- **Emoji Mart:** the shadow-root adapter retains native search behavior. Search mirrors the shared 40px minimum field, 12px corners, 14px body type, inset fill, metadata placeholder, and perimeter stroke. Keyboard focus and reduced motion are immediate. The widget uses the host appearance preference.
- **Disclosures:** persisted channel groups and diagnostic content retain native disclosure semantics and local state.
- **Identity and navigation:** avatars, previews, links, mentions, and thread summaries keep their existing owners. Composer mentions use inert InlineChip rendering. Editing or deleting a mention removes its explicit intent; host-owned recipient avatars can clear that intent without changing authored text. Solo chats require an explicit agent tag to send.
- **Host defaults:** Panel marks its surface separately from interactive controls, so native product and plugin content inside it can still receive host defaults.
- **Compatibility:** legacy utilities forward to shared roles for existing callers and plugins. Use semantic names and shared components in new work.

## Form adoption

Do not add feature selectors that repaint shared inputs, textareas, or selects.

Field owns link-lab URL errors. Workflow validation
stays in `editor-model.ts`, with field and step locations on each issue when known.
Form mode connects name, message, delay, and timeout errors to their controls and
reveals step options when a timeout needs attention. YAML mode shows validation
on the YAML field and restores its helper text after correction.

Unsupported conversion to Form mode is a separate notice: valid advanced YAML
remains valid and saveable. Keep request failures, permissions, and whole-workflow
problems in feature-level notices instead of marking an unrelated field invalid.
Shared styling does not change save gates, secret handling, or relay validation.

## Check a migration

Exercise pointer and keyboard paths, loading, failure, and recovery. Inspect both
themes, narrow layouts, and enlarged text in the actual app; a viewer example
cannot confirm that the host loads the right stylesheet.

Retain browser coverage for community joining, workflow save/recovery, draft and
sidebar persistence, media insertion, and focus. Media coverage includes tab/panel
associations, keyboard activation, and search clearing. Moving to shared styles is
not a reason to remove a browser journey or weaken its behavioral assertions.

Follow [the contribution workflow](contributing.md#interactive-product-iteration)
for iteration and completed-batch checks. Record deferred checks. A draft PR or
running preview does not establish native behavior or full validation.

## Composition review

Reviewed on 2026-10-09 against app commit `2bea18769`, with local documentation
changes. This is an adoption snapshot, not blanket approval of these components.
Use [DESIGN.md's whole-surface recipes](../src/shared/design-system/DESIGN.md#compose-the-whole-surface)
as the target; remove resolved gaps from this table when their migrations are verified.
During PR preparation, source references were refreshed against `a6ea532d6`,
including the Me workspace. The browser observations below remain tied to
`2bea18769`; the newer Me workspace and Agents page were not browser-retested.
The Me and Sessions pages named in this snapshot have since been retired: Solo
chats now open in Messages, so those observations are historical.

Browser inspection covered Messages, Inbox, Reminders, Projects, Agents, Sessions,
Workflows, Me, the account menu, Channel members, a profile companion panel, and
Profile, Appearance, Notifications, and Builderlab Settings. The existing configured
community loaded. Inspection used dark mode at 1280×720, with an additional
Appearance check at 480×800. Menu Escape returned focus to its trigger; the member
dialog's initial search focus and loading-to-list layout were observed.
No forms were submitted or settings changed. Desktop-only agent management,
light-mode parity, 200% zoom, RTL, full keyboard journeys, destructive/pending/error
paths, and slow-motion playback were **not verified**. Source-only observations
below are labelled separately. No product fixes are included in this documentation pass.

### Patterns to reuse

| Surface | Example and the specific pattern it demonstrates |
| --- | --- |
| Conversation workspace | [ChannelsPage](../src/bundled/channels/ChannelsPage.tsx): pane identity and icon actions, timeline scroll ownership, persistent composer |
| Collection with detail | [InboxPage](../src/bundled/inbox/InboxPage.tsx): filters in the body and list/detail ownership |
| Solo chats | [ChannelsPage](../src/bundled/channels/ChannelsPage.tsx) Solo treatment ([SoloHeading](../src/bundled/channels/SoloHeading.tsx)): flat timeline/composer in the shared conversation page and panel workspace |
| Immediate settings | [NotificationSettings](../src/app/NotificationSettings.tsx), [AppearanceSettings](../src/app/AppearanceSettings.tsx): shared preference rows, grouped controls, and contextual permission feedback |
| Explicit-save settings | [ProfileSettings](../src/app/ProfileSettings.tsx): scoped description, labelled fields, preserved draft/save behavior. [IdentitySettings](../src/app/IdentitySettings.tsx) owns separate identity details |
| Bounded modal | [ChannelMembersDialog](../src/bundled/channels/ChannelMembersDialog.tsx): stable shell, fixed search/filter area, bounded results; [RemindDialog](../src/bundled/reminders/RemindDialog.tsx) is the short-form source reference |
| Anchored actions | [ChannelHeaderMenu](../src/bundled/channels/ChannelHeaderMenu.tsx): shared Menu parts, grouped actions, and focus handoff; account-menu composition is feature-specific |
| Contributed detail | [ProfilePanel](../src/bundled/profiles/ProfilePanel.tsx) inside [PanelCard](../src/features/panels/PanelCard.tsx): body content and tabs within host-supplied framing |

### Gaps to address when migrating owners

All entries below concern consistency or adoption; they do not establish a broken
interaction or authorize a redesign of the feature's behavior.

| Before | After | Why |
| --- | --- | --- |
| [Repository views](../src/bundled/repos/RepoPage.tsx) begin with feature-authored large headings; loading replaces the heading too. Observed in the browser. | Adopt the shared pane composition, with filters, scoped notices, and labelled task actions in the body. Keep identity stable across loading and results. | A destination should remain recognizable while its content changes. |
| [Builderlab Login](../src/bundled/builderlab/login/Login.tsx) uses its own heading/gaps; [PairingSettings](../src/bundled/pairing/PairingSettings.tsx) uses a different hand-built heading. Builderlab observed; Pairing source-reviewed. | Use the Settings content Header and appropriate form/preference/management grouping. Preserve integration-specific instructions and steps. | Settings registration does not render consistent content hierarchy for the plugin. |
| [PanelSubview](../src/features/panels/PanelSubview.tsx) focuses its Back control on entry. Adding an IconButton title opens a Tooltip that consumes the first Escape before Back; reproduced in the existing focus/return component test during an isolated trial. | Preserve accessible names and the existing one-Escape Back contract until the shared Tooltip policy supports both. Current controls omit the new hint. | A mandatory hint recipe can conflict with an established keyboard contract; token guards do not detect this. |

### Enforcement boundary

Existing guards check many color, type, icon, spacing, and CSS-adoption rules.
They do not prove that a page has the right hierarchy, that an action belongs in a
particular slot, or that a plugin avoids duplicate framing. The custom workflow
button is a concrete example: its non-module stylesheet falls outside the adoption
guard's CSS-module control-override scan. Flexible React slots also accept text header
actions. External plugin trees are not made conformant by registration alone.

Review the complete rendered composition and its contributing components. Any
future executable guard or stricter component API needs a specific contract,
current callers, focused regression coverage, and a migration plan; do not hide
these gaps by broadening exceptions or claim this documentation mechanically
enforces arbitrary plugin UI.

Before planning live inspection, read entry effects as well as click handlers.
For example, Pair mobile starts a pairing session when opened with native identity
and a selected community. Use the existing controlled pairing fixture when the
review is limited to layout; avoiding the submit button does not make entry read-only.
