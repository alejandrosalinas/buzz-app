export type ComponentStatus = "core" | "proposed";

/** Documentation location, independent from the source folder. */
export type ComponentCollection = "components" | "product-ui";

/**
 * A Base UI part a component is built on. `name` is the export as documented;
 * `docs` is the path segment on base-ui.com/react/components, and `module` is
 * the import specifier, so the two cannot be claimed independently of the code.
 */
export type BaseUiPart = {
  name: string;
  docs: string;
  module: string;
};

export const BASE_UI_PARTS = {
  alertDialog: {
    name: "Alert Dialog",
    docs: "alert-dialog",
    module: "@base-ui/react/alert-dialog",
  },
  radio: { name: "Radio", docs: "radio", module: "@base-ui/react/radio" },
  radioGroup: {
    name: "Radio Group",
    docs: "radio-group",
    module: "@base-ui/react/radio-group",
  },
  checkbox: {
    name: "Checkbox",
    docs: "checkbox",
    module: "@base-ui/react/checkbox",
  },
  avatar: { name: "Avatar", docs: "avatar", module: "@base-ui/react/avatar" },
  button: { name: "Button", docs: "button", module: "@base-ui/react/button" },
  contextMenu: {
    name: "Context Menu",
    docs: "context-menu",
    module: "@base-ui/react/context-menu",
  },
  field: { name: "Field", docs: "field", module: "@base-ui/react/field" },
  input: { name: "Input", docs: "input", module: "@base-ui/react/input" },
  menu: { name: "Menu", docs: "menu", module: "@base-ui/react/menu" },
  select: { name: "Select", docs: "select", module: "@base-ui/react/select" },
  combobox: {
    name: "Combobox",
    docs: "combobox",
    module: "@base-ui/react/combobox",
  },
  switch: { name: "Switch", docs: "switch", module: "@base-ui/react/switch" },
  slider: { name: "Slider", docs: "slider", module: "@base-ui/react/slider" },
  tabs: { name: "Tabs", docs: "tabs", module: "@base-ui/react/tabs" },
  accordion: {
    name: "Accordion",
    docs: "accordion",
    module: "@base-ui/react/accordion",
  },
  tooltip: {
    name: "Tooltip",
    docs: "tooltip",
    module: "@base-ui/react/tooltip",
  },
  dialog: { name: "Dialog", docs: "dialog", module: "@base-ui/react/dialog" },
  popover: {
    name: "Popover",
    docs: "popover",
    module: "@base-ui/react/popover",
  },
  previewCard: {
    name: "Preview Card",
    docs: "preview-card",
    module: "@base-ui/react/preview-card",
  },
} as const satisfies Record<string, BaseUiPart>;

export const BASE_UI_DOCS_ROOT = "https://base-ui.com/react/components";

export function baseUiDocsUrl(part: BaseUiPart): string {
  return `${BASE_UI_DOCS_ROOT}/${part.docs}`;
}

export type ComponentDefinition = {
  slug: string;
  name: string;
  purpose: string;
  behavior: string;
  variants: readonly string[];
  status: ComponentStatus;
  /** Where this component appears in the design-system navigation. */
  collection: ComponentCollection;
  owner?: string;
  /**
   * The component whose frame this component belongs inside in the design
   * system navigation. This is documentation hierarchy, not an import graph:
   * a child remains independently usable and documented on its own page.
   */
  parent?: string;
  /** The file this component lives in, relative to `src/`. */
  source: string;
  /**
   * The Base UI parts this component imports itself. Empty means it is built
   * from native elements — which is a legitimate answer, not a gap: a header,
   * a section, and a surface have no behaviour to inherit.
   */
  baseUi: readonly BaseUiPart[];
  /**
   * Sibling components it composes, by slug. A component with no Base UI part
   * of its own can still inherit behaviour through one of these.
   */
  composes: readonly string[];
};

export const COMPONENTS: readonly ComponentDefinition[] = [
  {
    slug: "loading-region",
    name: "LoadingRegion",
    purpose:
      "Keep read feedback quiet when fast and content stable while pending.",
    behavior:
      "One-second delayed status, immediate ready content and aria-busy. The caller owns stable child geometry, scope and errors.",
    variants: ["initial read", "refresh", "screen-reader status"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/LoadingRegion.tsx",
    baseUi: [],
    composes: [],
  },
  {
    slug: "empty-state",
    name: "EmptyState",
    purpose:
      "Explain an empty collection, introduce setup, or present a status action.",
    behavior:
      "Static content with a decorative icon, grouped copy, and an optional action. Uses label-sm/body-sm type, a 48ch measure, and logical spacing; callers distinguish empty results from loading or errors.",
    variants: ["with action", "informational", "unframed"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/EmptyState.tsx",
    baseUi: [],
    composes: [],
  },
  {
    slug: "calendar",
    name: "Calendar",
    purpose: "Choose a date using a month grid.",
    behavior:
      "React DayPicker owns calendar arithmetic and keyboard navigation; Buzz owns styling and Tabler navigation icons.",
    variants: ["single date", "selected", "today", "disabled dates"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/Calendar.tsx",
    baseUi: [],
    composes: [],
  },
  {
    slug: "field-button",
    name: "FieldButton",
    purpose: "Open a picker with the same shape and inset as a text field.",
    behavior: "Base UI Button composes with menu and popover triggers.",
    variants: ["default", "disabled", "expanded"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/FieldButton.tsx",
    baseUi: [BASE_UI_PARTS.button],
    composes: [],
  },
  {
    slug: "toast",
    name: "Toast",
    purpose:
      "Compact feedback without moving the page or hiding recovery actions.",
    behavior:
      "Sonner owns bottom-right placement, announcements, expiry and swipe dismissal. Buzz supplies themed content and an expanded, scrollable recovery stack. F6 focuses notifications.",
    variants: ["transient", "actionable", "dismissible", "navigable"],
    status: "core",
    collection: "components",
    source: "shared/design-system/ui/Toast.tsx",
    baseUi: [],
    composes: ["button", "icon-button"],
  },
  {
    slug: "alert-dialog",
    name: "AlertDialog",
    purpose: "Confirm a consequential action before continuing.",
    behavior:
      "Centered 25rem confirmation with 2rem insets (1rem at viewport widths up to 30rem), a grouped title/description header and secondary Close control. Optional body content precedes actions; header-only confirmations omit the body. Base UI owns modal focus and alert-dialog semantics.",
    variants: ["default", "pending"],
    status: "core",
    collection: "components",
    source: "shared/design-system/ui/AlertDialog.tsx",
    baseUi: [BASE_UI_PARTS.alertDialog],
    composes: ["icon-button"],
  },
  {
    slug: "tooltip",
    name: "Tooltip",
    purpose: "A short hint for an already labelled control.",
    behavior: "Base UI owns focus, positioning and dismissal.",
    variants: ["helpful hint", "familiar hint", "follow pointer"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/Tooltip.tsx",
    baseUi: [BASE_UI_PARTS.tooltip],
    composes: [],
  },

  {
    slug: "dialog",
    name: "Dialog",
    purpose: "A shared modal frame with title, content and actions.",
    behavior:
      "Shared title/description header and secondary Close; 2rem insets (1rem at viewport widths up to 30rem) and a fixed 1rem minimum gutter above footer buttons outside scrolling content. Compact dialogs center; task modals start 8rem from the top. Base UI owns focus, default outside dismissal and transition presence; shared motion tokens animate entry and exit. The host can preserve native titlebar dragging through the backdrop.",
    variants: [
      "compact (25rem)",
      "default (40rem)",
      "wide (55rem)",
      "expanded (72rem)",
      "motion none",
      "flex body",
      "footer gap none",
      "stable-tall height",
      "padded chrome",
      "search presentation",
      "centered artwork header",
      "integrated navigation",
      "host container (sectioned: bounded 72rem × 48rem)",
    ],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/Dialog.tsx",
    baseUi: [BASE_UI_PARTS.dialog],
    composes: ["icon-button"],
  },

  {
    slug: "checkbox",
    name: "Checkbox",
    purpose: "Choose an independent option.",
    behavior: "Base UI owns form and keyboard semantics.",
    variants: ["default", "size: sm | md", "disabled", "invalid"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/Checkbox.tsx",
    baseUi: [BASE_UI_PARTS.checkbox],
    composes: [],
  },

  {
    slug: "radio-group",
    name: "RadioGroup",
    purpose:
      "Choose one option, including labelled settings cards and text-only tiles.",
    behavior: "Base UI owns form and keyboard semantics.",
    variants: [
      "default",
      "card",
      "tile",
      "size: sm | md",
      "disabled",
      "invalid",
    ],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/RadioGroup.tsx",
    baseUi: [
      BASE_UI_PARTS.radioGroup,
      BASE_UI_PARTS.radio,
      BASE_UI_PARTS.field,
    ],
    composes: [],
  },

  {
    slug: "textarea",
    name: "Textarea",
    purpose: "A multiline field with shared label and validation behavior.",
    behavior: "Base UI owns form and keyboard semantics.",
    variants: ["default", "outlined", "panel surface", "disabled", "invalid"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/Textarea.tsx",
    baseUi: [BASE_UI_PARTS.field],
    composes: [],
  },

  {
    slug: "input",
    name: "Input",
    purpose:
      "A single-line text field. InputGroup owns the shared frame for leading and trailing content.",
    behavior:
      "Base UI owns form and keyboard semantics. InputGroup supports inset and panel surfaces while its native input retains focus.",
    variants: [
      "default",
      "disabled",
      "invalid",
      "title",
      "InputGroup panel surface",
    ],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/Input.tsx",
    baseUi: [BASE_UI_PARTS.input],
    composes: [],
  },

  {
    slug: "field",
    name: "Field",
    purpose:
      "Label, description and error for a form control; `optional` marks fields a form doesn't require.",
    behavior: "Base UI owns form and keyboard semantics.",
    variants: ["default", "disabled", "invalid"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/Field.tsx",
    baseUi: [BASE_UI_PARTS.field],
    composes: [],
  },

  {
    slug: "swap-workspace",
    name: "Panel Swap",
    purpose:
      "Explore two-panel resizing, swapping, and tab grouping. Drag empty header space to rearrange: the panel follows the pointer, its neighbor moves after halfway, and release settles the layout. Drag a title onto another header to combine panels as tabs; a purple pill and insertion line show the destination while both panes stay in place. Release combines them in one layout update. Drag a combined tab toward an edge to separate it; a black directional cue shows the split. Edge cues also preview horizontal or vertical arrangements, applied on release. Widths and heights are remembered separately. Only movement animates; resizing and structural changes are immediate, with no timed hold or full-panel overlay.",
    behavior:
      "Pointer capture, live transforms, keyboard swapping, and Base UI separator semantics.",
    variants: ["two panels"],
    status: "proposed",
    collection: "product-ui",
    owner: "desktop-new Workspace",
    source: "shared/design-system/ui/SwapWorkspaceExperiment.tsx",
    baseUi: [
      {
        name: "Separator",
        docs: "separator",
        module: "@base-ui/react/separator",
      },
    ],
    composes: ["panel", "button", "tabs"],
  },
  {
    slug: "flex-workspace",
    name: "Flex Layout",
    purpose:
      "Compare FlexLayout docking with the Dockview playground. Drag and resize blank panels using the library’s standard controls, with Buzz colors and rounded tabs. There are no custom drag handles or placement restrictions.",
    behavior: "FlexLayout tabs, docking, and resizing.",
    variants: ["native docking"],
    status: "proposed",
    collection: "product-ui",
    owner: "desktop-new Workspace",
    source: "shared/design-system/ui/FlexWorkspace.tsx",
    baseUi: [],
    composes: ["button"],
  },
  {
    slug: "workspace",
    name: "DocView",
    purpose:
      "Arrange panels with continuous resizing and purple edge-drop highlights. Navigation stays anchored at the upper left; a panel may sit below it. Only splits that leave both panels usable are offered. No presets or tab stacking.",
    behavior: "Dockview pointer dragging and resize.",
    variants: ["split-only"],
    status: "proposed",
    collection: "product-ui",
    owner: "desktop-new Workspace",
    source: "shared/design-system/ui/BentoWorkspace.tsx",
    baseUi: [],
    composes: ["panel-header"],
  },
  {
    slug: "theme-picker",
    name: "ThemePicker",
    purpose:
      "Choose System, Light, or Dark using miniature interface previews with the selected message color.",
    behavior: "Shared radio keyboard navigation and accessible choice labels.",
    variants: ["default"],
    status: "proposed",
    collection: "components",
    owner: "Buzz Settings",
    source: "shared/design-system/ui/ThemePicker.tsx",
    baseUi: [],
    composes: ["field", "radio-group"],
  },
  {
    slug: "count-badge",
    name: "CountBadge",
    purpose:
      "Show a quiet item count, such as drafts, at the end of a navigation row.",
    behavior:
      "Image role with an exact spoken count; caps the visible number at 99+. Not interactive.",
    variants: ["single digit", "multiple digits", "capped", "selected row"],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/CountBadge.tsx",
    baseUi: [],
    composes: [],
  },
  {
    slug: "keyboard-shortcut",
    name: "KeyboardShortcut",
    purpose:
      "Present one keyboard chord in a quiet capsule with spoken key names.",
    behavior: "Semantic keyboard hint; not interactive.",
    variants: ["default"],
    status: "proposed",
    collection: "components",
    owner: "Buzz Settings",
    source: "shared/design-system/ui/KeyboardShortcut.tsx",
    baseUi: [],
    composes: [],
  },
  {
    slug: "settings-group",
    name: "SettingsGroup",
    purpose:
      "A subtle bordered container for related settings rows or form fields, or a stack of individually bordered cards.",
    behavior:
      "Presentation only; children retain their labels, state, and interactions.",
    variants: ["rows", "form", "cards"],
    status: "proposed",
    collection: "components",
    owner: "Buzz Settings",
    source: "shared/design-system/ui/SettingsGroup.tsx",
    baseUi: [],
    composes: [],
  },
  {
    slug: "preference-row",
    name: "PreferenceRow",
    purpose:
      "A settings row with an optional icon, title, subtitle, and trailing control or status.",
    behavior:
      "The row supplies control label associations; trailing controls own interaction and state.",
    variants: [
      "title",
      "subtitle",
      "icon",
      "switch",
      "checkbox",
      "button",
      "status",
      "disabled",
    ],
    status: "proposed",
    collection: "components",
    owner: "Buzz Settings",
    source: "shared/design-system/ui/PreferenceRow.tsx",
    baseUi: [],
    composes: [],
  },
  {
    slug: "switch",
    name: "Switch",
    purpose: "A labelled setting that is on or off.",
    behavior: "Base UI owns checked state and keyboard behavior.",
    variants: ["off", "on", "disabled", "visible or accessible-only label"],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Design system",
    source: "shared/design-system/ui/Switch.tsx",
    baseUi: [BASE_UI_PARTS.switch],
    composes: [],
  },
  {
    slug: "button",
    name: "Button",
    purpose:
      "Trigger an action with a single-line label. Choose its emphasis and size, and use the shared loading or destructive state when needed.",
    behavior: "Base UI Button.",
    variants: [
      "prominent",
      "subtle",
      "subtle-muted",
      "ghost",
      "destructive",
      "outline",
      "attention (proposed): light dashed danger outline with slow marching ants",
      "glass",
      "glass-ghost (proposed): quiet artwork control with glass hover/open states",
      "glass-clear (proposed): barely-there glass secondary action over bright brand surfaces",
      "inverted",
      "link",
      "plain: unfilled text disclosure without an underline",
      "glass (proposed): frosted action over profile artwork",
      "size: caption (32px, caption text) | inline | row (8px insets, stretched label) | xs | sm | md (default) | lg",
      "medium leading icon + label: 12px leading / 16px trailing inset (proposed)",
      "shape: capsule (default) | control (12px) | icon (square, 10px)",
      "SurfaceButton: artwork layout with shared activation and focus (proposed)",
      "loading",
    ],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/Button.tsx",
    baseUi: [BASE_UI_PARTS.button],
    composes: [],
  },
  {
    slug: "split-button",
    name: "SplitButton",
    purpose:
      "Run a primary action and open its options or related actions from an attached menu.",
    behavior:
      "Composes Buzz Button and Menu as one joined capsule, including while the menu is open. The caller owns option changes and related actions; the menu is unavailable while the action loads.",
    variants: [
      "subtle (default)",
      "outline: halves share one stroke",
      "prominent",
      "size: xs | sm | md (default)",
      "loading",
      "disabled",
    ],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Agents",
    source: "shared/design-system/ui/SplitButton.tsx",
    baseUi: [],
    composes: ["button", "menu"],
  },
  {
    slug: "icon-button",
    name: "IconButton",
    purpose:
      "Trigger an action with an icon. Give every IconButton an accessible label that describes the action.",
    behavior: "Composes Buzz Button.",
    variants: [
      "prominent",
      "subtle",
      "subtle-muted",
      "ghost",
      "glass-ghost (proposed)",
      "inverted",
      "destructive",
      "destructive-quiet (muted at rest, danger on hover and press)",
      "outline",
      "attention (proposed): light dashed danger outline with slow marching ants",
      "link",
      "inset (secondary action matching segmented filter tracks)",
      "tint",
      "chrome",
      "avatar",
      "media",
      "bare (no background in any state; glyph-state toggles use 20px artwork at sm; row-revealed actions retain standard artwork sizing)",
      "shape: inset (container radius minus inset via --control-inset-radius) | control (default, 10px) | round (avatar default) | row-end | squircle (prominent avatar edit action)",
      "size: xs (20px, 12px icon) | sm (default, 32px, 16px icon) | md (40px) | lg (52px)",
      "legacy aliases: quiet, solid, compact, toolbar, default, large",
    ],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/IconButton.tsx",
    baseUi: [],
    composes: ["button"],
  },
  {
    slug: "avatar",
    name: "Avatar",
    purpose:
      "Show a person or agent with an image or stable fallback. Use a circle for a person and a squircle for an agent, based on identity data supplied by the caller.",
    behavior: "Base UI Avatar.",
    variants: [
      "tiny",
      "compact",
      "small",
      "default",
      "large",
      "fill",
      "circle",
      "squircle",
    ],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/Avatar.tsx",
    baseUi: [BASE_UI_PARTS.avatar],
    composes: [],
  },
  {
    slug: "avatar-stack",
    name: "AvatarStack",
    purpose:
      "Show overlapping identities, three unless the caller sets a maximum, and an overflow count on one line. The enclosing control supplies the accessible name.",
    behavior:
      "Decorative artwork composed from Avatar; mini, small, and hero sizes use a surface-colored inset to separate overlapping images. Identity data stays with the caller. Optional entrance motion respects reduced motion.",
    variants: [
      "mini",
      "compact",
      "small",
      "hero",
      "hero-large",
      "circle",
      "squircle",
      "overflow count",
    ],
    status: "proposed",
    collection: "components",
    owner: "Messages",
    source: "shared/design-system/ui/AvatarStack.tsx",
    baseUi: [],
    composes: ["avatar"],
  },
  {
    slug: "typing-dots",
    name: "TypingDots",
    purpose:
      "Show received/waiting activity with unison breathing, and working activity with staggered dots. The caller supplies the state and accessible text.",
    behavior:
      "CSS-only decorative motion. Reduced motion keeps the dots still; receipt detection and lifecycle state stay with the feature.",
    variants: ["waiting", "working (default)", "small", "reduced motion"],
    status: "proposed",
    collection: "components",
    owner: "Messages",
    source: "shared/design-system/ui/TypingDots.tsx",
    baseUi: [],
    composes: [],
  },
  {
    slug: "shimmer-text",
    name: "ShimmerText",
    purpose:
      "Give a short live-work label, such as an agent's current step, a moving sheen while that work is live.",
    behavior:
      "CSS-only decorative motion over subtle-to-standard text roles. Reduced motion shows plain text; the caller decides when work is live.",
    variants: ["active (default)", "inactive", "reduced motion"],
    status: "proposed",
    collection: "components",
    owner: "Messages",
    source: "shared/design-system/ui/ShimmerText.tsx",
    baseUi: [],
    composes: [],
  },
  {
    slug: "preview-card",
    name: "PreviewCard",
    purpose:
      "Show an object’s available context in a non-modal preview on hover or focus.",
    behavior:
      "Base UI Preview Card; optional destination anchor supports pointer and keyboard activation.",
    variants: ["default", "destination"],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/PreviewCard.tsx",
    baseUi: [BASE_UI_PARTS.previewCard],
    composes: [],
  },
  {
    slug: "inline-chip",
    name: "InlineChip",
    purpose:
      "A reference to a person, agent, channel, message, or link shown inline in a sentence.",
    behavior: "Semantic native button or image role.",
    variants: [
      "person",
      "agent",
      "channel",
      "message",
      "link",
      "resolved preview",
      "loading",
      "unresolved",
    ],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/InlineChip.tsx",
    baseUi: [],
    composes: ["preview-card"],
  },
  {
    slug: "full-page-surface",
    name: "FullPageSurface",
    purpose:
      "Use one rounded surface to fill a page’s workspace. For multiple panels, compose Panel directly.",
    behavior:
      "Semantic native region; the page owns content padding, scrolling, alignment, and composition.",
    variants: ["full workspace"],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Design system",
    source: "shared/design-system/ui/FullPageSurface.tsx",
    baseUi: [],
    composes: ["panel"],
  },
  {
    slug: "panel",
    name: "Panel",
    purpose:
      "Group workspace content on a shared surface. Panel owns fill, border, corners, shadow, and clipping; the feature owns headers, spacing, scrolling, and resizing.",
    behavior: "Semantic native region.",
    variants: ["panel", "capsule", "card"],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/Panel.tsx",
    baseUi: [],
    composes: [],
  },
  {
    slug: "tabs",
    name: "Tabs",
    purpose:
      "Switch between sibling views. Choose dock for static icon-only shell destinations with a theme-accent selected fill and inactive hover feedback, chrome for grouped tabs on the app backdrop, panel for a plain surface, segmented for grouped filters on an opaque surface, workspace for combined panes, or navigation for content-sized tabs capped at 12rem with icons or avatars. Closable tabs provide a sibling close button and support Delete or middle-click. The caller owns selection, retained content, and the next selection after closing.",
    behavior:
      "Base UI Tabs. Icon-only variants keep item labels accessible. Dock labels use instant tooltips to the right of vertical docks or beneath horizontal docks; segmented-icons labels remain available as titles. Items can be disabled. Navigation items accept attentionRequest to identify a repeated opening without changing focus or remounting content. Hosts may opt movable tabs into Panel Swap title-only dragging using TabDragFeedback; hosts own hit testing, cancellation and the committed order. tabMenu composes the host’s scoped Close all tabs action with Rename tab in one shared menu, without changing tab selection.",
    variants: [
      "chrome",
      "dock",
      "panel",
      "workspace",
      "navigation",
      "segmented",
      "segmented-icons",
      "size: sm (32px) | md (40px default), for segmented filters",
    ],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/Tabs.tsx",
    baseUi: [BASE_UI_PARTS.tabs],
    composes: [],
  },
  {
    slug: "header",
    name: "Header",
    purpose:
      "Introduce page content with a title and optional subtitle, eyebrow, icon, or actions. Use InlineHeader for groups within the page.",
    behavior: "Semantic heading with caller-selected level.",
    variants: ["header", "inline"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/Header.tsx",
    baseUi: [],
    composes: [],
  },
  {
    slug: "panel-header",
    name: "PanelHeader",
    purpose:
      "Give a panel a consistent header with optional navigation, icon, title, and actions. The row has a 2.5rem minimum height; the panel and its content stay with the caller.",
    behavior: "Semantic native header.",
    variants: ["default", "compact", "card"],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    parent: "panel",
    source: "shared/design-system/ui/PanelHeader.tsx",
    baseUi: [],
    composes: [],
  },
  {
    slug: "search-field",
    name: "SearchField",
    purpose: "A compact filter field with a search cue and clear action.",
    behavior:
      "Base UI Field and Input; trailing actions sit after Clear inside the shared frame.",
    variants: ["default", "capsule", "palette"],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/SearchField.tsx",
    baseUi: [BASE_UI_PARTS.input],
    composes: ["field", "icon-button"],
  },
  {
    slug: "composer",
    name: "Composer",
    purpose:
      "The message drafting frame: editable content, contextual information, tools, send state and delivery feedback.",
    behavior:
      "Native form and textarea semantics; product capabilities supply rich editing and tool behavior.",
    variants: [
      "empty",
      "draft",
      "multiline",
      "context",
      "sending",
      "error",
      "disabled",
      "narrow",
    ],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/Composer.tsx",
    baseUi: [],
    composes: ["icon-button"],
  },
  {
    slug: "sidebar-navigation",
    name: "SidebarNavigation",
    purpose:
      "One compact sidebar composition shared by Solo, Multiplayer and Settings.",
    behavior:
      "Owns main's row appearance and static section rhythm without adding a landmark, surface, layout box or scrollport. Features retain data, selection, unread, disclosure and drag behavior.",
    variants: ["named sections", "headingless reference", "wrapping sections"],
    status: "core",
    collection: "components",
    source: "shared/design-system/ui/SidebarNavigation.tsx",
    baseUi: [],
    composes: ["navigation-section", "navigation-item"],
  },
  {
    slug: "navigation-section",
    name: "NavigationSection",
    purpose: "A named group of related rows in a dense workspace navigator.",
    behavior:
      "Semantic native section, composed inside SidebarNavigation for shared compact heading and grouping rhythm. NavigationSectionHeading is its one heading row: the label fills, actions hug, and neither overlays nor reserves space for the other.",
    variants: [
      "default",
      "headingless",
      "inside SidebarNavigation",
      "disclosure heading",
      "revealed actions",
    ],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/NavigationSection.tsx",
    baseUi: [],
    composes: [],
  },
  {
    slug: "navigation-item",
    name: "NavigationItem",
    purpose:
      "A selectable destination row or pill with optional icon and metadata.",
    behavior: "Base UI Button.",
    variants: [
      "row",
      "pill",
      "option",
      "text",
      "inset",
      "selected",
      "highlighted",
      "inside SidebarNavigation",
      "multiline stacked labels",
      "NavigationCard with independent details",
      "tonal and inset NavigationCard with nested branch interaction and one hovered surface per sidebar",
      "NavigationCard drag destination enclosure",
    ],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/NavigationItem.tsx",
    baseUi: [BASE_UI_PARTS.button],
    composes: [],
  },
  {
    slug: "accordion",
    name: "Accordion",
    purpose: "Reveal related content without leaving the page.",
    behavior:
      "Base UI owns expansion, keyboard activation, and panel semantics; keepMounted preserves local form state while collapsed.",
    variants: [
      "default",
      "form",
      "settings",
      "navigation",
      "activity",
      "section (proposed): InlineHeader type and unindented content",
      "controlled expansion",
    ],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Design system",
    source: "shared/design-system/ui/Accordion.tsx",
    baseUi: [BASE_UI_PARTS.accordion],
    composes: [],
  },
  {
    slug: "combobox",
    name: "Combobox",
    purpose:
      "Search and choose from a set of options. The field includes a browse control and a shared option popup. A dropdown trigger can place search inside the popup.",
    behavior:
      "Base UI owns keyboard navigation, selection and positioning; callers own filtering, custom values and async discovery. Compact popups keep search visible above scrollable results and can retain a preferred side within the available height.",
    variants: ["default", "compact", "compact popup", "loading", "disabled"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/Combobox.tsx",
    baseUi: [BASE_UI_PARTS.combobox],
    composes: ["field", "icon-button"],
  },
  {
    slug: "popover",
    name: "Popover",
    purpose:
      "An anchored surface for supporting details, short forms, and interactive content.",
    behavior:
      "Base UI owns positioning, focus restoration and dismissal; feature code owns content and state.",
    variants: ["content", "list", "none", "compact", "wide"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/Popover.tsx",
    baseUi: [BASE_UI_PARTS.popover],
    composes: [],
  },
  {
    slug: "choice-row",
    name: "ChoiceRow",
    purpose:
      "A label, optional description, leading artwork and trailing detail inside a choice.",
    behavior:
      "Presentational content; the containing control owns selection, interaction and semantics.",
    variants: ["label", "description", "icon", "avatar", "trailing detail"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/ChoiceRow.tsx",
    baseUi: [],
    composes: [],
  },
  {
    slug: "menu",
    name: "Menu",
    purpose: "Present contextual actions and choices from a compact trigger.",
    behavior:
      "Base UI owns positioning, dismissal, keyboard navigation, selection, and nested submenus. Context menus appear immediately and expose their visible lifetime to source rows; dropdowns and submenus retain their entrance motion.",
    variants: [
      "actions",
      "compact",
      "links",
      "checkbox choices",
      "radio choices: check (default) | highlight",
      "group label: default | quiet",
      "nested submenus",
      "danger: matching label/icon color and danger hover/pressed fill",
      "disabled: matching label, trailing text, and indicator color",
    ],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Design system",
    source: "shared/design-system/ui/Menu.tsx",
    baseUi: [BASE_UI_PARTS.menu, BASE_UI_PARTS.contextMenu],
    composes: [],
  },
  {
    slug: "select",
    name: "Select",
    purpose:
      "Choose one value from a finite list. Use inline for compact filters, compact for trailing row choices, and field for forms.",
    behavior:
      "Base UI owns focus, keyboard selection, grouping, and dismissal.",
    variants: [
      "inline",
      "compact",
      "field",
      "button size: xs | sm | md",
      "disabled",
      "align: start | center | end",
      "compact link",
      "compact inverted: app-background fill",
      "compact glass-ghost (proposed)",
      "compact value suffix",
      "optional group separator",
      "20px leading accessory: icon, avatar, or custom UI; compact insets 8px leading / 12px trailing",
    ],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Design system",
    source: "shared/design-system/ui/Select.tsx",
    baseUi: [BASE_UI_PARTS.select],
    composes: ["field", "button"],
  },
];

/**
 * What a component is actually built on, once composition is followed.
 *
 * `own` is what the file itself imports from Base UI. `inherited` is what it
 * gets through a sibling — IconButton has no Base UI import of its own, but it
 * renders a Buzz Button, so Base UI Button's behaviour is still underneath it.
 * Reporting only `own` would call that component unbacked, which is wrong; not
 * distinguishing them would hide where the dependency actually enters.
 */
export type BaseUiBacking = {
  own: readonly BaseUiPart[];
  inherited: readonly { part: BaseUiPart; through: string }[];
};

export function resolveBaseUiBacking(slug: string): BaseUiBacking {
  const byPart = new Map<string, { part: BaseUiPart; through: string }>();
  const root = COMPONENTS.find((candidate) => candidate.slug === slug);
  if (!root) return { own: [], inherited: [] };

  // Bounded by the registry itself, and `seen` makes a cycle terminate rather
  // than recurse — a component composing a component that composes it back is a
  // mistake we would rather see as a missing row than a hung page.
  const seen = new Set<string>([slug]);
  const queue = [...root.composes];

  while (queue.length > 0) {
    const nextSlug = queue.shift();
    if (!nextSlug || seen.has(nextSlug)) continue;
    seen.add(nextSlug);

    const next = COMPONENTS.find((candidate) => candidate.slug === nextSlug);
    if (!next) continue;

    for (const part of next.baseUi) {
      if (!byPart.has(part.name))
        byPart.set(part.name, { part, through: next.name });
    }
    queue.push(...next.composes);
  }

  // A part imported directly is reported once, as its own — not twice because a
  // composed sibling happens to use it too.
  for (const part of root.baseUi) byPart.delete(part.name);

  return { own: root.baseUi, inherited: [...byPart.values()] };
}
