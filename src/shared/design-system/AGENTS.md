# Agent guide

Use this system for new Buzz UI and for existing surfaces as they migrate.
Before editing, read [the design guide](DESIGN.md) and
[Maintaining the design system](MAINTAINING_DESIGN_SYSTEM.md).
For screen composition, start with [the decision table](DESIGN.md#start-here-when-building-a-screen)
and [whole-surface recipes](DESIGN.md#compose-the-whole-surface). Choose the recipe
for the page, detail panel, Settings content, dialog, or anchored surface. Check
[plugin contribution boundaries](DESIGN.md#plugin-contribution-boundaries) before
adding chrome. Review consumers and action producers, not just shared frames;
flexible props do not enforce the composition rules.

## Keep decisions with their owner

- Shared components live in `ui/`, values and recipes in `styles/`, and documentation metadata in `tokens/` and `ui/registry.ts`.
- Use semantic color roles and complete type roles. Buzz's tokens and `DESIGN.md` are the visual reference; Base UI owns interaction behavior except Toast, which uses Sonner through the shared Toast API. Import Tabler icons through `icons/`.
- Keep palette steps in shared token definitions. Product code uses roles and shared components, not viewer-specific layouts or styles.
- Keep features, plugins, native adapters, and app startup out of the system and core viewer. The viewer at `tests/fixtures/design-system` renders real shared components.
- Integrate global styles through the host entry point with one reset. The host owns appearance; `theme/useColorScheme.ts` belongs to the standalone viewer.

For dialogs, use `Dialog` / `AlertDialog` and the guide's
[modal composition](DESIGN.md#modal-composition). Put introductory copy in
`description`, not a separate body paragraph. Omit an absent body; use shared
size, inset, footer-gutter, Close, and motion recipes rather than local overrides.
Shared insets are 2rem, reducing to 1rem at viewport widths up to 30rem; keep
this responsive rule in the shared recipe. The standard viewer specimens show
these compositions.

## Preserve interaction contracts

Keep keyboard focus, Tab order, selection, dismissal, and focus restoration intact.
Keyboard focus must stay visible; follow
[Focus appearance](DESIGN.md#focus-appearance). Do not add local
replacement rings. Preserve the underlying keyboard-focus recipes and their space.

For rows in dialogs and panels, follow
[Align row content, not state backgrounds](DESIGN.md#align-row-content-not-state-backgrounds):
offset the list wrapper, retain shared row padding, align icon slots, and preserve
narrow-screen gutters and space for keyboard focus.

Public-key labels use `src/shared/identity/public-key.ts`. Do not slice keys by hand
or add a visual component for this formatting. Follow
[Public identity text](DESIGN.md#public-identity-text), and never pass secret keys.

## Check the change

Inspect light and dark mode at narrow, intermediate, and wide widths. Exercise the
changed interaction with a keyboard and pointer. Run the root `design:typecheck`,
`design:check`, `design:test`, and `design:build` scripts for the completed change,
following the root contribution workflow’s iteration and validation gates.
