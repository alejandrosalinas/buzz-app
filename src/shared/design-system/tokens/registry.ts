import { ACCENTS, BRAND_GRADIENTS, PALETTE_FAMILIES } from "./brand";

/**
 * Documentation metadata for the shared tokens: names, purposes, sources,
 * and adoption status. The viewer renders these entries; token guards check
 * them against the CSS. Keep each description aligned with its current use.
 * Add a `use` sentence and, for proposed roles, an `owner`. Follow DESIGN.md.
 */

/** Whether a token is part of the vetted system or someone's addition. */
export type TokenStatus = "core" | "proposed" | "deprecated";

/** A private ramp step. Components never reference these. */
export interface RampStep {
  /** Position on the ramp. The number means a job, not a brightness. */
  step: number;
  /** What this step is for. */
  job: string;
  /** The CSS custom property, without `var()`. */
  variable: string;
}

/** A private ramp. */
export interface Ramp {
  id: string;
  name: string;
  /** Why this ramp exists and how it behaves. */
  description: string;
  steps: RampStep[];
  /** Rendered over the app backdrop so translucency is visible. */
  translucent?: boolean;
}

/** A public role. The only layer a screen may use. */
export interface Role {
  /** The Tailwind class, e.g. `bg-panel`. */
  token: string;
  /** The CSS custom property backing it. */
  variable: string;
  /** What it points at, for display: `neutral 1`, or a note for exceptions. */
  pointsAt: string;
  /** One sentence: when to use this. */
  use: string;
  status: TokenStatus;
  /** Required when status is `proposed`. */
  owner?: string;
  /** Set when the value is a literal rather than a ramp reference. */
  exception?: string;
}

export interface RoleGroup {
  id: string;
  name: string;
  description: string;
  roles: Role[];
}

/* ============================================================
   PRIVATE RAMPS
   ============================================================ */

/**
 * General purposes for the twelve palette steps. Actual role mappings live
 * in tokens.css and can differ from these defaults. Use `pnpm design:census`
 * to inspect current consumers before changing a mapping.
 */
const STEP_JOBS = [
  "lightest surface",
  "subtle surface",
  "tinted surface",
  "tinted surface, hovered",
  "quiet border, or a selected surface",
  "border",
  "stronger border",
  "border hover, focus ring",
  "solid fill",
  "solid fill, hovered",
  "text on a tint, or an inverse fill",
  "high-contrast text",
];

/** A palette hue: twelve steps, authored per mode. The bottom layer. */
export interface PaletteHue {
  id: string;
  /** Which identity, if any, currently draws from this hue. */
  usedBy?: string;
  steps: Array<{ step: number; variable: string; job: string }>;
}

/**
 * A private, named backdrop treatment.
 *
 * Unlike a colour ramp, a treatment is a complete visual composition: several
 * colours plus their positions, falloff, and sometimes a vignette. Its name is
 * deliberately mode-specific — Night garden is the dark counterpart of Sky
 * field, not Sky field with its brightness turned down.
 */
export interface BackdropTreatment {
  id: string;
  name: string;
  variable: string;
  mode: "light" | "dark";
  pairedWith: string;
  description: string;
}

/**
 * Raw palette values are based on Radix Colors (MIT), with Buzz adjustments
 * in tokens.css. These are copied values, not a Radix component dependency.
 * Each hue has authored light and dark steps; components use semantic roles.
 */
export const PALETTE: PaletteHue[] = [
  { id: "neutral", usedBy: "structure", steps: [] },
  { id: "purple", usedBy: "categorical", steps: [] },
  { id: "red", usedBy: "danger", steps: [] },
  { id: "green", usedBy: "success", steps: [] },
  { id: "amber", usedBy: "warning", steps: [] },
  { id: "blue", usedBy: "info", steps: [] },
  { id: "cyan", steps: [] },
  { id: "orange", steps: [] },
].map((hue) => ({
  ...hue,
  steps: Array.from({ length: 12 }, (_, i) => ({
    step: i + 1,
    variable: `--${hue.id}-${i + 1}`,
    job: STEP_JOBS[i] ?? "Palette step",
  })),
}));

// Existing Appearance ramps are palette owners in both modes.
PALETTE.push(
  ...PALETTE_FAMILIES.map((id) => ({
    id,
    usedBy: BRAND_GRADIENTS.some(
      ({ start, end }) =>
        start.startsWith(`${id}-`) || end.startsWith(`${id}-`),
    )
      ? ACCENTS.some((family) => family === id)
        ? "Appearance and artwork"
        : "artwork"
      : "Appearance",
    steps: STEP_JOBS.map((job, index) => ({
      step: index + 1,
      variable: `--${id}-${index + 1}`,
      job,
    })),
  })),
);

export const BACKDROP_TREATMENTS: BackdropTreatment[] = [
  {
    id: "sky-field",
    name: "Sky field",
    variable: "--gradient-sky-field",
    mode: "light",
    pairedWith: "night-garden",
    description: "Blue sky, fresh green, and a sunlit yellow edge.",
  },
  {
    id: "peach-field",
    name: "Peach field",
    variable: "--gradient-peach-field",
    mode: "light",
    pairedWith: "signal-flare",
    description: "A bright peach wash with a cool blue edge.",
  },
  {
    id: "blue-hour",
    name: "Blue hour",
    variable: "--gradient-blue-hour",
    mode: "light",
    pairedWith: "electric-dusk",
    description: "Cyan, periwinkle, and a quiet lavender horizon.",
  },
  {
    id: "orchid-field",
    name: "Orchid field",
    variable: "--gradient-orchid-field",
    mode: "light",
    pairedWith: "ultraviolet",
    description: "Lilac, periwinkle, and a low orchid-pink bloom.",
  },
  {
    id: "night-garden",
    name: "Night garden",
    variable: "--gradient-night-garden",
    mode: "dark",
    pairedWith: "sky-field",
    description: "Deep teal atmosphere, emerald high light, and blue below.",
  },
  {
    id: "signal-flare",
    name: "Signal flare",
    variable: "--gradient-signal-flare",
    mode: "dark",
    pairedWith: "peach-field",
    description:
      "A warm ember field with orange high light and a rose horizon.",
  },
  {
    id: "electric-dusk",
    name: "Electric dusk",
    variable: "--gradient-electric-dusk",
    mode: "dark",
    pairedWith: "blue-hour",
    description: "Cyan and ultraviolet light over a deep blue atmosphere.",
  },
  {
    id: "ultraviolet",
    name: "Ultraviolet",
    variable: "--gradient-ultraviolet",
    mode: "dark",
    pairedWith: "orchid-field",
    description: "A deep violet field, blue high light, and a low rose flare.",
  },
];

/** The four stable appearance slots, each pairing one light and dark scene. */
export const BACKDROP_CHOICES = [
  {
    token: "gradient-1",
    variable: "--gradient-1",
    lightTreatment: "sky-field",
    darkTreatment: "night-garden",
    use: "Legacy glass specimen: Sky field in light mode, Night garden in dark.",
  },
  {
    token: "gradient-2",
    variable: "--gradient-2",
    lightTreatment: "peach-field",
    darkTreatment: "signal-flare",
    use: "A legacy warm glass specimen: Peach field in light mode, Signal flare in dark.",
  },
  {
    token: "gradient-3",
    variable: "--gradient-3",
    lightTreatment: "blue-hour",
    darkTreatment: "electric-dusk",
    use: "A legacy cool glass specimen: Blue hour in light mode, Electric dusk in dark.",
  },
  {
    token: "gradient-4",
    variable: "--gradient-4",
    lightTreatment: "orchid-field",
    darkTreatment: "ultraviolet",
    use: "A legacy violet glass specimen: Orchid field in light mode, Ultraviolet in dark.",
  },
] as const;

export const RAMPS: Ramp[] = [
  {
    id: "glass",
    name: "Glass",
    description:
      "Glass fills increase in opacity within each mode. Materials use these steps for rest and hover, and add a separate rim and blur.",
    translucent: true,
    steps: [
      { step: 1, job: "barely there", variable: "--glass-1" },
      { step: 2, job: "quiet glass", variable: "--glass-2" },
      { step: 3, job: "default glass", variable: "--glass-3" },
      { step: 4, job: "glass hovered", variable: "--glass-4" },
      { step: 5, job: "nearly solid", variable: "--glass-5" },
    ],
  },
];

/* ============================================================
   PUBLIC ROLES
   ============================================================ */

/** Semantic roles name color jobs; the palette remains an implementation detail. */
export const ROLE_GROUPS: RoleGroup[] = [
  {
    id: "plugin-artwork",
    name: "Plugin artwork (proposed)",
    description:
      "Palette-backed category artwork used by the Settings plugin catalog.",
    roles: BRAND_GRADIENTS.flatMap((gradient) =>
      (["start", "end", "gradient"] as const).map(
        (part): Role => ({
          token: `art-plugin-${gradient.category}-${part}`,
          variable: `--art-plugin-${gradient.category}-${part}`,
          pointsAt:
            part === "gradient"
              ? `${gradient.start} → ${gradient.end}`
              : part === "start"
                ? `--${gradient.start}`
                : `--${gradient.end}`,
          use: `${gradient.name} decorative artwork ${part}.`,
          status: "proposed",
          owner: "Settings plugin catalog",
          ...(part === "gradient"
            ? {
                exception:
                  "Complete decorative composition of palette-backed endpoints.",
              }
            : {}),
        }),
      ),
    ),
  },
  {
    id: "semantic-surface",
    name: "Surface",
    description: "Shared surface roles, with values for both themes.",
    roles: [
      {
        token: "bg-surface-base",
        variable: "--surface-base",
        pointsAt: "neutral-2 light / neutral-1 dark",
        use: "The plain background behind panels.",
        status: "core",
      },
      {
        token: "bg-surface-categorical-purple",
        variable: "--surface-categorical-purple",
        pointsAt: "purple-3 light / purple-3 dark",
        use: "Accent-independent categorical fill, paired with text-categorical-purple.",
        status: "core",
      },
      {
        token: "bg-surface-panel",
        variable: "--surface-panel",
        pointsAt: "neutral-1 light / neutral-3 dark",
        use: "A content panel or card.",
        status: "core",
      },
      {
        token: "bg-surface-composer",
        variable: "--surface-composer",
        pointsAt: "surface-panel light / neutral-4 dark",
        use: "Message drafting surface, raised above the panel in dark mode.",
        status: "core",
      },
      {
        token: "bg-surface-popover",
        variable: "--surface-popover",
        pointsAt: "neutral-1 light / neutral-raised dark",
        use: "A menu, dialog or other raised surface.",
        status: "core",
      },
      {
        token: "bg-surface-inverse",
        variable: "--surface-inverse",
        pointsAt: "neutral-11 light / neutral-11 dark",
        use: "Image and video stages; pair labels with text-inverse.",
        status: "core",
      },
      {
        token: "bg-surface-message",
        variable: "--surface-message",
        pointsAt: "bubble-received in both modes",
        use: "Received message bubbles; pair with standard text and links.",
        status: "core",
      },
      {
        token: "bg-surface-message-own",
        variable: "--surface-message-own",
        pointsAt: "accent 4 at Chillin’; accent 9 at Buzzin’",
        use: "Own message bubbles; pair with --text-message-own.",
        status: "core",
      },
      {
        token: "bg-surface-message-hover",
        variable: "--surface-message-hover",
        pointsAt:
          "surface-message mixed 5% toward black in light mode / white in dark mode",
        use: "Received bubble fill while its actions show; text and media are unchanged.",
        status: "core",
      },
      {
        token: "bg-surface-message-own-hover",
        variable: "--surface-message-own-hover",
        pointsAt:
          "surface-message-own mixed 5% toward black in light mode / white in dark mode",
        use: "Own bubble fill while its actions show; text and media are unchanged.",
        status: "core",
      },
      {
        token: "--affordance-message-own-hover",
        variable: "--affordance-message-own-hover",
        pointsAt:
          "black 4% on light bubbles / white 8% on dark ones; at Buzzin’, black 4% on the accent fill (white 8% on Mono in light mode)",
        use: "Overlay across your own bubble while its actions show. It follows the bubble's lightness, as its chips do.",
        status: "core",
      },
      {
        token: "--affordance-message-highlight",
        variable: "--affordance-message-highlight",
        pointsAt: "black 10% light / white 16% dark",
        use: "Temporary arrival cue across a received bubble; replaces hover while it shows.",
        status: "core",
      },
      {
        token: "--affordance-message-own-highlight",
        variable: "--affordance-message-own-highlight",
        pointsAt:
          "affordance-message-highlight; at Buzzin’, the accent's regular overlay step on its fill (black 10%, white 16% on Mono in light mode)",
        use: "Temporary arrival cue across your own bubble. It follows the bubble's lightness, as its chips do.",
        status: "core",
      },
      {
        token: "--affordance-reaction",
        variable: "--affordance-reaction",
        pointsAt: "black 6% light / white 10% dark",
        use: "Reaction strip on received bubbles and the panel; the add-reaction hover lays it again on top.",
        status: "core",
      },
      {
        token: "--affordance-reaction-own",
        variable: "--affordance-reaction-own",
        pointsAt:
          "affordance-reaction; at Buzzin’, black 6% on the accent fill (white 10% on Mono in light mode)",
        use: "Reaction strip inside your own bubble. It follows the bubble's lightness, as its chips do.",
        status: "core",
      },
      {
        token: "--affordance-reaction-self",
        variable: "--affordance-reaction-self",
        pointsAt: "surface-message-own at Buzzin’; accent-9 at Chillin’",
        use: "A reaction you made, on received bubbles and the panel: your own bubble's fill, paired with text-reaction-self.",
        status: "core",
      },
      {
        token: "--affordance-reaction-self-own",
        variable: "--affordance-reaction-self-own",
        pointsAt:
          "surface-message at Buzzin’; neutral-1 at Chillin’ (neutral-7 in dark mode)",
        use: "A reaction you made inside your own bubble: the received bubble's fill, paired with text-reaction-self-own.",
        status: "core",
      },
      {
        token: "bg-surface-message-highlight",
        variable: "--surface-message-highlight",
        pointsAt: "accent step 3",
        use: "Temporary arrival cue on a message without a filled bubble; follows the accent color.",
        status: "core",
      },
      {
        token: "bg-surface-inset",
        variable: "--surface-inset",
        pointsAt: "neutral-2 light / neutral-2 dark",
        use: "A recessed region inside a panel.",
        status: "core",
      },
    ],
  },
  {
    id: "semantic-text",
    name: "Text",
    description: "Shared text roles, with values for both themes.",
    roles: [
      {
        token: "text-standard",
        variable: "--text-standard",
        pointsAt: "neutral-standard-text light / neutral-12 dark",
        use: "Normal reading text.",
        status: "core",
      },
      {
        token: "text-subtle",
        variable: "--text-subtle",
        pointsAt: "neutral-10 light / neutral-11 dark",
        use: "Supporting text that must remain readable.",
        status: "core",
      },
      {
        token: "text-metadata",
        variable: "--text-metadata",
        pointsAt: "neutral-9 light / neutral-10 dark",
        use: "Nonessential metadata.",
        status: "core",
      },
      {
        token: "text-row",
        variable: "--text-row",
        pointsAt:
          "text-navigation; text-sidebar-hover inside SidebarNavigation",
        use: "Primary navigation text on a hovered or selected row; follows the row's fill.",
        status: "proposed",
      },
      {
        token: "text-row-selected",
        variable: "--text-row-selected",
        pointsAt:
          "text-navigation-selected; text-sidebar-selected inside SidebarNavigation",
        use: "Navigation label on the selected row; sidebar labels use the solid fill's paired ink.",
        status: "proposed",
      },
      {
        token: "text-row-selected-subtle",
        variable: "--text-row-selected-subtle",
        pointsAt:
          "text-navigation-selected; text-sidebar-selected inside SidebarNavigation",
        use: "Icons and supporting text on the selected sidebar destination.",
        status: "proposed",
      },
      {
        token: "text-row-selected-metadata",
        variable: "--text-row-selected-metadata",
        pointsAt:
          "text-navigation-selected; text-sidebar-selected inside SidebarNavigation",
        use: "Counts and metadata on the selected sidebar destination.",
        status: "proposed",
      },
      {
        token: "bg-affordance-navigation-selected",
        variable: "--affordance-navigation-selected",
        pointsAt:
          "surface-navigation-selected; surface-sidebar-selected inside SidebarNavigation",
        use: "Selected navigation fill; SidebarNavigation scopes this alias to its solid accent fill.",
        status: "proposed",
      },
      {
        token: "bg-surface-dock-count",
        variable: "--surface-dock-count",
        pointsAt: "dark mono 2 in both modes",
        use: "Dark corner count capsules on dock tiles; pair with text-dock-count.",
        status: "core",
      },
      {
        token: "text-dock-count",
        variable: "--text-dock-count",
        pointsAt: "dark-mode accent link ink in both modes",
        use: "Readable accent numerals on surface-dock-count.",
        status: "core",
      },
      {
        token: "bg-surface-row-selected-detail",
        variable: "--surface-row-selected-detail",
        pointsAt: "neutral-2 light / neutral-6 dark",
        use: "Quiet fill for working, typing and count badges on a selected sidebar row.",
        status: "proposed",
      },
      {
        token: "text-row-selected-detail",
        variable: "--text-row-selected-detail",
        pointsAt: "neutral standard ink light / text-row-selected dark",
        use: "Readable marks on surface-row-selected-detail, independent of the row's strong fill.",
        status: "proposed",
      },
      {
        token: "text-row-subtle",
        variable: "--text-row-subtle",
        pointsAt: "text-subtle; text-sidebar-hover inside SidebarNavigation",
        use: "Supporting text on a hovered or selected row; follows the row's fill.",
        status: "proposed",
      },
      {
        token: "text-row-metadata",
        variable: "--text-row-metadata",
        pointsAt: "text-metadata; text-sidebar-hover inside SidebarNavigation",
        use: "Metadata on a hovered or selected row; follows the row's fill.",
        status: "proposed",
      },
      {
        token: "text-chrome-subtle",
        variable: "--text-chrome-subtle",
        pointsAt: "text-subtle (neutral)",
        use: "Inactive labels in the chrome capsule on the app shell.",
        status: "proposed",
      },
      {
        token: "text-inverse",
        variable: "--text-inverse",
        pointsAt: "neutral-1 light / neutral-1 dark",
        use: "Text on prominent actions and inverse media surfaces.",
        status: "core",
      },
      {
        token: "text-on-selection",
        variable: "--text-on-selection",
        pointsAt: "neutral-1 light / neutral-1 dark",
        use: "Selected text on surface-text-selection, including composer tokens.",
        status: "core",
      },
      {
        token: "text-on-selection-own",
        variable: "--text-on-selection-own",
        pointsAt: "neutral-1 / own bubble fill at Buzzin’",
        use: "Selected text inside outgoing bubbles, paired with surface-text-selection-own.",
        status: "core",
      },
      {
        token: "text-on-prominent",
        variable: "--text-on-prominent",
        pointsAt: "text-inverse (neutral prominent controls)",
        use: "Text and icons on a prominent fill: buttons, checked controls, tooltips, badges.",
        status: "proposed",
      },
      {
        token: "text-unavailable",
        variable: "--text-unavailable",
        pointsAt: "neutral-7 light / neutral-7 dark",
        use: "Unavailable controls only.",
        status: "core",
      },
      {
        token: "text-danger",
        variable: "--text-danger",
        pointsAt: "red-text light / red-12 dark",
        use: "Error text and destructive action labels.",
        status: "core",
      },
      {
        token: "text-call-leave",
        variable: "--text-call-leave",
        pointsAt: "red-10 light / red-10 dark",
        use: "Huddle Leave label and icon on glass or neutral controls. Product-directed lighter red; contrast exception, not general error text.",
        status: "proposed",
        owner: "Huddles",
      },
      {
        token: "text-warning",
        variable: "--text-warning",
        pointsAt: "amber-12 light / amber-12 dark",
        use: "Warning text.",
        status: "core",
      },
      {
        token: "text-success",
        variable: "--text-success",
        pointsAt: "green-text light / green-12 dark",
        use: "Success text.",
        status: "core",
      },
      {
        token: "icon-status-progress",
        variable: "--icon-status-progress",
        pointsAt: "amber-10 light / amber-10 dark",
        use: "In-progress task icons, paired with a distinct shape and accessible status label. Not text.",
        status: "core",
      },
      {
        token: "icon-status-complete",
        variable: "--icon-status-complete",
        pointsAt: "green-10 light / green-10 dark",
        use: "Completed task icons, paired with a checkmark and accessible status label. Not text.",
        status: "core",
      },
      {
        token: "icon-subtle",
        variable: "--icon-subtle",
        pointsAt: "text-subtle",
        use: "Neutral / inactive state icons, including inside message bubbles. Not text.",
        status: "core",
      },
      {
        token: "icon-subtle-own",
        variable: "--icon-subtle-own",
        pointsAt: "icon-subtle; the own bubble's link ink at Buzzin’",
        use: "Neutral state icons inside your own bubble, where the solid fill clears no grey.",
        status: "core",
      },
      {
        token: "icon-success",
        variable: "--icon-success",
        pointsAt: "green-11 light / green-11 dark",
        use: "Success / positive state icons, including inside message bubbles. Not text.",
        status: "core",
      },
      {
        token: "icon-success-own",
        variable: "--icon-success-own",
        pointsAt: "icon-success; the own bubble's link ink at Buzzin’",
        use: "Success state icons inside your own bubble, where the solid fill clears no green.",
        status: "core",
      },
      {
        token: "text-link",
        variable: "--text-link",
        pointsAt: "text-standard (neutral outside message bubbles)",
        use: "Inline links in prose. Mentions use text-mention on a highlight instead.",
        status: "core",
      },
      {
        token: "text-message-own",
        variable: "--text-message-own",
        pointsAt: "accent 12 at low contrast; accent ink at high contrast",

        use: "Prose on the selected outgoing message surface.",
        status: "core",
      },
      {
        token: "text-message-link-own",
        variable: "--text-message-link-own",
        pointsAt: "accent link at Chillin’; accent ink at Buzzin’",
        use: "Links on the selected outgoing message surface.",
        status: "core",
      },
      {
        token: "text-reaction-self",
        variable: "--text-reaction-self",
        pointsAt: "text-message-own at Buzzin’; accent ink at Chillin’",
        use: "Count of a reaction you made on received bubbles and the panel, paired with bg-affordance-reaction-self.",
        status: "core",
      },
      {
        token: "text-reaction-self-own",
        variable: "--text-reaction-self-own",
        pointsAt: "text-standard",
        use: "Count of a reaction you made inside your own bubble, paired with bg-affordance-reaction-self-own.",
        status: "core",
      },
      {
        token: "text-mention",
        variable: "--text-mention",
        pointsAt: "text-standard",
        use: "Ordinary mention labels, paired with bg-affordance-mention. Mentions are people, not links.",
        status: "core",
      },
      {
        token: "text-mention-own",
        variable: "--text-mention-own",
        pointsAt: "text-mention; the own bubble's ink at Buzzin’",
        use: "Mention labels inside your own bubble, paired with bg-affordance-mention-own.",
        status: "core",
      },
      {
        token: "text-mention-self",
        variable: "--text-mention-self",
        pointsAt: "text-on-accent",
        use: "A mention of you, paired with bg-affordance-mention-self. It asks for your attention, so it joins the strong group.",
        status: "core",
      },
      {
        token: "text-categorical-purple",
        variable: "--text-categorical-purple",
        pointsAt: "purple-12 light / purple-12 dark",
        use: "Accent-independent categorical text, paired with surface-categorical-purple.",
        status: "core",
      },
      {
        token: "icon-categorical-purple",
        variable: "--icon-categorical-purple",
        pointsAt: "purple-11 light / purple-11 dark",
        use: "Accent-independent categorical state icons, the icon tier of text-categorical-purple. Not text.",
        status: "core",
      },
      {
        token: "icon-categorical-purple-own",
        variable: "--icon-categorical-purple-own",
        pointsAt:
          "icon-categorical-purple; the own bubble's link ink at Buzzin’",
        use: "Categorical state icons inside your own bubble, where the solid fill clears no purple.",
        status: "core",
      },
      {
        token: "text-accent",
        variable: "--text-accent",
        pointsAt: "text-standard (neutral compatibility role)",
        use: "Linked or selected identity text.",
        status: "core",
      },
    ],
  },
  {
    id: "file-artwork",
    name: "File artwork",
    description: "Fixed document-format artwork colors in both themes.",
    roles: [
      {
        token: "file-pdf-surface",
        variable: "--file-pdf-surface",
        pointsAt: "#ffffff",
        use: "White PDF icon tile, paired with file-pdf-ink.",
        status: "core",
        exception:
          "Document-format artwork retains a fixed color pair across themes.",
      },
      {
        token: "file-pdf-ink",
        variable: "--file-pdf-ink",
        pointsAt: "#d32f2f",
        use: "Red PDF glyph on file-pdf-surface.",
        status: "core",
        exception:
          "Document-format artwork retains a fixed color pair across themes.",
      },
    ],
  },
  {
    id: "semantic-status",
    name: "Status",
    description:
      "Presence badge and label colors, paired across light and dark surfaces.",
    roles: [
      {
        token: "status-online",
        variable: "--status-online",
        pointsAt: "green-11 light / green-11 dark",
        use: "Running activity status fill.",
        status: "core",
      },
      {
        token: "status-availability-online",
        variable: "--status-availability-online",
        pointsAt: "green-10 light / green-10 dark",
        use: "Online availability label. Accepted contrast exception: below AA in light mode and APCA in both modes; see docs/presence.md.",
        status: "core",
      },
      {
        token: "status-avatar-online",
        variable: "--status-avatar-online",
        pointsAt: "green-10 light / green-10 dark",
        use: "Online avatar badge center, paired with status-avatar-online-border.",
        status: "core",
      },
      {
        token: "status-away",
        variable: "--status-away",
        pointsAt: "amber-10 light / amber-10 dark",
        use: "Unoutlined Away avatar badge and availability label tint; label text uses text-warning. The light badge has an accepted non-text contrast shortfall; see DESIGN.md.",
        status: "core",
      },
      {
        token: "status-avatar-online-border",
        variable: "--status-avatar-online-border",
        pointsAt: "green-11 light / green-11 dark",
        use: "Online avatar outline; provides 3:1 against adjacent surfaces.",
        status: "core",
      },
      {
        token: "status-offline",
        variable: "--status-offline",
        pointsAt: "neutral-8 light / neutral-10 dark",
        use: "Offline presence dot.",
        status: "core",
      },
    ],
  },
  {
    id: "chart",
    name: "Chart series",
    description:
      "Marks that tell chart series apart, assigned in order and never cycled. Labels and values keep text roles.",
    roles: [
      "blue-10 light / blue-9 dark",
      "orange-10 light / orange-8 dark",
      "green-10 light / green-9 dark",
      "purple-9 light / purple-10 dark",
    ].map((pointsAt, index) => ({
      token: `chart-series-${index + 1}`,
      variable: `--chart-series-${index + 1}`,
      pointsAt,
      use: `Series ${index + 1} bars, lines and legend swatches; 3:1 against panels.`,
      status: "core",
    })),
  },
  {
    id: "scrollbars",
    name: "Scrollbars",
    description:
      "Native thin scrollbars with transparent tracks in both themes.",
    roles: [
      {
        token: "scrollbar-thumb",
        variable: "--scrollbar-thumb",
        pointsAt: "neutral-8 light / neutral-9 dark (gray)",
        use: "Gray native scrollbar thumb on a transparent track, including vendor shadow roots.",
        status: "core",
      },
      {
        token: "scrollbar-thumb-quiet",
        variable: "--scrollbar-thumb-quiet",
        pointsAt: "border-standard at 90% opacity",
        use: "Quiet sidebar and navigation-tab scrollbar thumb, revealed on interaction.",
        status: "core",
      },
    ],
  },
  {
    id: "semantic-border",
    name: "Border",
    description: "Shared border roles, with values for both themes.",
    roles: [
      {
        token: "border-standard",
        variable: "--border-standard",
        pointsAt: "neutral-3 light / neutral-5 dark",
        use: "A quiet separator or panel edge.",
        status: "core",
      },
      {
        token: "border-message-thread",
        variable: "--border-message-thread",
        pointsAt: "neutral-4 light / neutral-6 dark",
        use: "Reply connectors and thread spines on conversation surfaces.",
        status: "core",
      },
      {
        token: "border-prominent",
        variable: "--border-prominent",
        pointsAt: "neutral-8 light / neutral-8 dark",
        use: "A visible input or choice boundary.",
        status: "core",
      },
      {
        token: "border-floating-control",
        variable: "--border-floating-control",
        pointsAt: "border-prominent light / neutral-9 dark",
        use: "Control boundary on floating surfaces, including fields and unchecked choices.",
        status: "proposed",
      },
      {
        token: "border-focus",
        variable: "--border-focus",
        pointsAt: "neutral-12 light / neutral-12 dark",
        use: "Keyboard focus.",
        status: "core",
      },
      {
        token: "border-success-subtle",
        variable: "--border-success-subtle",
        pointsAt: "green-6 light / green-6 dark",
        use: "A decorative separator inside a success control.",
        status: "core",
      },
      {
        token: "border-danger",
        variable: "--border-danger",
        pointsAt: "red-9 light / red-9 dark",
        use: "Invalid field boundary.",
        status: "core",
      },
      {
        token: "border-warning",
        variable: "--border-warning",
        pointsAt: "amber-11 light / amber-9 dark",
        use: "Warning boundary.",
        status: "core",
      },
      {
        token: "border-accent",
        variable: "--border-accent",
        pointsAt: "border-focus (neutral compatibility role)",
        use: "An identity accent boundary.",
        status: "core",
      },
    ],
  },
  {
    id: "semantic-affordance",
    name: "Affordance",
    description: "Shared affordance roles, with values for both themes.",
    roles: [
      {
        token: "text-message-link",
        variable: "--text-message-link",
        pointsAt: "accent link",
        use: "Links in received message bubbles.",
        status: "core",
      },
      {
        token: "surface-sidebar-selected",
        variable: "--surface-sidebar-selected",
        pointsAt: "accent 9",
        use: "Persistent sidebar selection, independent of vibe.",
        status: "core",
      },
      {
        token: "text-sidebar-selected",
        variable: "--text-sidebar-selected",
        pointsAt: "accent contrast",
        use: "Labels, icons and metadata on selected sidebar rows.",
        status: "core",
      },
      {
        token: "affordance-sidebar-hover",
        variable: "--affordance-sidebar-hover",
        pointsAt: "accent 2 light / accent 3 dark",
        use: "Sidebar row hover and Solo card drop destinations, quieter than selection.",
        status: "core",
      },
      {
        token: "text-sidebar-hover",
        variable: "--text-sidebar-hover",
        pointsAt: "accent 12",
        use: "Text on hovered sidebar rows.",
        status: "core",
      },
      {
        token: "bg-surface-control-selected",
        variable: "--surface-control-selected",
        pointsAt: "surface-panel at both vibe levels",
        use: "Persistent segmented selection; pair with text-control-selected.",
        status: "core",
      },
      {
        token: "text-control-selected",
        variable: "--text-control-selected",
        pointsAt: "text-standard at both vibe levels",
        use: "Labels and icons on surface-control-selected.",
        status: "core",
      },
      {
        token: "--surface-navigation-selected",
        variable: "--surface-navigation-selected",
        pointsAt: "affordance-selected (neutral)",
        use: "Selected navigation fill, paired with text-navigation-selected.",
        status: "core",
      },
      {
        token: "--text-navigation-selected",
        variable: "--text-navigation-selected",
        pointsAt: "text-standard (neutral)",
        use: "Labels and icons on selected navigation.",
        status: "core",
      },
      {
        token: "bg-affordance-prominent",
        variable: "--affordance-prominent",
        pointsAt: "neutral-12 in both modes",

        use: "The main action fill.",
        status: "core",
      },
      {
        token: "bg-affordance-prominent-hover",
        variable: "--affordance-prominent-hover",
        pointsAt: "neutral-11 light / neutral-11 dark",
        use: "The main action under a pointer.",
        status: "core",
      },
      {
        token: "bg-affordance-prominent-pressed",
        variable: "--affordance-prominent-pressed",
        pointsAt: "neutral-action-pressed",
        use: "The main action while pressed.",
        status: "core",
      },
      {
        token: "bg-affordance-prominent-mark",
        variable: "--affordance-prominent-mark",
        pointsAt: "affordance-prominent (neutral)",
        use: "A prominent dot, insertion line or label standing alone on a surface; stays 3:1 by itself.",
        status: "proposed",
      },
      {
        token: "bg-affordance-subtle",
        variable: "--affordance-subtle",
        pointsAt:
          "neutral-2 light / neutral-4 dark; neutral-5 in dark composers",
        use: "A secondary action fill.",
        status: "core",
      },
      {
        token: "bg-affordance-subtle-hover",
        variable: "--affordance-subtle-hover",
        pointsAt:
          "neutral-quiet-hover in both modes; neutral-6 in dark composers",
        use: "A secondary action under a pointer.",
        status: "core",
      },
      {
        token: "--affordance-backdrop-hover",
        variable: "--affordance-backdrop-hover",
        pointsAt: "black 6% light / white 10% dark",
        use: "Translucent top-bar hover fills over the shell and its dot texture.",
        status: "core",
      },
      {
        token: "--affordance-backdrop-pressed",
        variable: "--affordance-backdrop-pressed",
        pointsAt: "black 10% light / white 16% dark",
        use: "Translucent top-bar pressed and selected fills over the shell and its dot texture.",
        status: "core",
      },
      {
        token: "bg-affordance-subtle-pressed",
        variable: "--affordance-subtle-pressed",
        pointsAt:
          "neutral-4 light / neutral-5 dark; neutral-7 in dark composers",
        use: "A secondary action while pressed.",
        status: "core",
      },
      {
        token: "--text-navigation",
        variable: "--text-navigation",
        pointsAt: "neutral-navigation-text light / neutral-11 dark",
        use: "Default sidenav labels: neutral-700 and Regular, as specified by Cynthia.",
        status: "proposed",
      },
      {
        token: "--text-navigation-unread",
        variable: "--text-navigation-unread",
        pointsAt: "neutral-navigation-unread light / neutral-12 dark",
        use: "Unread sidenav labels and notification numerals: neutral-800 and Semibold.",
        status: "proposed",
      },
      {
        token: "--affordance-navigation-quiet",
        variable: "--affordance-navigation-quiet",
        pointsAt: "neutral-navigation-quiet",
        use: "Gentle hover and selected fill for the sidenav, requested by Cynthia; paired with standard row text in both themes.",
        status: "proposed",
      },
      {
        token: "bg-affordance-row-hover",
        variable: "--affordance-row-hover",
        pointsAt: "affordance-subtle (neutral)",
        use: "A list or navigation row under the pointer, separate from resting quiet control fills.",
        status: "proposed",
      },
      {
        token: "bg-affordance-chrome",
        variable: "--affordance-chrome",
        pointsAt: "neutral-3 light / affordance-subtle dark",
        use: "The grouped chrome capsule on the app shell, such as Solo and Multiplayer.",
        status: "proposed",
      },
      {
        token: "bg-affordance-chrome-hover",
        variable: "--affordance-chrome-hover",
        pointsAt: "affordance-subtle-hover (neutral)",
        use: "An inactive chrome capsule item under the pointer.",
        status: "proposed",
      },
      {
        token: "bg-affordance-panel-hover",
        variable: "--affordance-panel-hover",
        pointsAt: "neutral-2 light / neutral-4 dark",
        use: "Quiet hover for navigation items on a panel. Unlike subtle controls, a panel row starts unfilled; keep its hover distinct from persistent selection.",
        status: "proposed",
        owner: "Morgan",
      },
      {
        token: "bg-affordance-floating-hover",
        variable: "--affordance-floating-hover",
        pointsAt: "neutral-2 light / neutral-5 dark",
        use: "Highlighted rows on floating surfaces. Pair with standard text, including supporting copy, to preserve readability in dark mode.",
        status: "core",
      },
      {
        token: "bg-affordance-popover-selected",
        variable: "--affordance-popover-selected",
        pointsAt: "neutral-2 light / neutral-6 dark",
        use: "Selection within anchored popups, including mention and emoji suggestions. Remains distinct from the raised dark popup surface independently of neutral button hover.",
        status: "core",
      },
      {
        token: "bg-affordance-floating-control",
        variable: "--affordance-floating-control",
        pointsAt: "neutral-3 light / neutral-6 dark",
        use: "Secondary action at rest on floating surfaces.",
        status: "proposed",
      },
      {
        token: "bg-affordance-floating-control-hover",
        variable: "--affordance-floating-control-hover",
        pointsAt: "neutral-4 light / neutral-7 dark",
        use: "Secondary action hover on floating surfaces; pair with standard text.",
        status: "proposed",
      },
      {
        token: "bg-affordance-floating-control-pressed",
        variable: "--affordance-floating-control-pressed",
        pointsAt: "neutral-5 light / neutral-8 dark",
        use: "Pressed action on floating surfaces; pair with standard text.",
        status: "proposed",
      },
      {
        token: "bg-affordance-floating-selected",
        variable: "--affordance-floating-selected",
        pointsAt: "affordance-subtle-pressed light / neutral-6 dark",
        use: "Persistent selection on floating surfaces, distinct from row hover; pair supporting copy with standard text.",
        status: "proposed",
      },
      {
        token: "bg-affordance-selected",
        variable: "--affordance-selected",
        pointsAt: "neutral-3 light / neutral-5 dark",
        use: "A persistently selected item.",
        status: "core",
      },
      {
        token: "bg-affordance-disabled",
        variable: "--affordance-disabled",
        pointsAt: "neutral-3 light / neutral-3 dark",
        use: "An unavailable control fill.",
        status: "core",
      },
      {
        token: "bg-affordance-danger",
        variable: "--affordance-danger",
        pointsAt: "red-3 light / red-3 dark",
        use: "A destructive action or error fill.",
        status: "core",
      },
      {
        token: "bg-affordance-danger-hover",
        variable: "--affordance-danger-hover",
        pointsAt: "red-4 light / red-4 dark",
        use: "A destructive action under a pointer.",
        status: "core",
      },
      {
        token: "bg-affordance-danger-pressed",
        variable: "--affordance-danger-pressed",
        pointsAt: "red-5 light / red-5 dark",
        use: "A destructive action while pressed.",
        status: "core",
      },
      {
        token: "bg-affordance-warning",
        variable: "--affordance-warning",
        pointsAt: "amber-3 light / amber-3 dark",
        use: "A warning fill.",
        status: "core",
      },
      {
        token: "surface-status-success",
        variable: "--surface-status-success",
        pointsAt: "citrus step 9",
        use: "Completed task fill, paired with text-on-status-success.",
        status: "core",
      },
      {
        token: "surface-status-danger",
        variable: "--surface-status-danger",
        pointsAt: "red light step 11",
        use: "Failed task fill, paired with text-on-status.",
        status: "core",
      },
      {
        token: "text-on-status-success",
        variable: "--text-on-status-success",
        pointsAt: "citrus ink",
        use: "Foreground on solid Citrus completed task status.",
        status: "core",
      },
      {
        token: "text-on-status",
        variable: "--text-on-status",
        pointsAt: "white",
        use: "Foreground on solid failed task status.",
        status: "core",
      },
      {
        token: "bg-affordance-success",
        variable: "--affordance-success",
        pointsAt: "green-3 light / green-3 dark",
        use: "A success fill.",
        status: "core",
      },
      {
        token: "bg-affordance-success-hover",
        variable: "--affordance-success-hover",
        pointsAt: "green-4 light / green-4 dark",
        use: "A success control under a pointer.",
        status: "core",
      },
      {
        token: "bg-affordance-success-pressed",
        variable: "--affordance-success-pressed",
        pointsAt: "green-5 light / green-5 dark",
        use: "A success control while pressed or expanded.",
        status: "core",
      },
      {
        token: "bg-affordance-call-join",
        variable: "--affordance-call-join",
        pointsAt: "green-10 light / green-10 dark",
        use: "Incoming Huddle join fill, paired with inverse text. Product-directed contrast exception.",
        status: "proposed",
        owner: "Huddles",
      },
      {
        token: "bg-affordance-call-join-hover",
        variable: "--affordance-call-join-hover",
        pointsAt: "green-9 light / green-9 dark",
        use: "Incoming Huddle join hover fill, paired with inverse text. Product-directed contrast exception.",
        status: "proposed",
        owner: "Huddles",
      },
      {
        token: "bg-affordance-call-decline",
        variable: "--affordance-call-decline",
        pointsAt: "red-10 light / red-10 dark",
        use: "Incoming Huddle decline fill, paired with inverse text. Product-directed contrast exception.",
        status: "proposed",
        owner: "Huddles",
      },
      {
        token: "bg-affordance-call-decline-hover",
        variable: "--affordance-call-decline-hover",
        pointsAt: "red-9 light / red-9 dark",
        use: "Incoming Huddle decline hover fill, paired with inverse text. Product-directed contrast exception.",
        status: "proposed",
        owner: "Huddles",
      },
      {
        token: "bg-affordance-link-hover",
        variable: "--affordance-link-hover",
        pointsAt: "affordance-subtle-hover (neutral)",
        use: "An inline link under a pointer.",
        status: "core",
      },
      {
        token: "bg-surface-text-selection",
        variable: "--surface-text-selection",
        pointsAt: "neutral-12 light / neutral-12 dark",
        use: "Text-selection fill distinct from panels and message bubbles; pair with text-on-selection.",
        status: "core",
      },
      {
        token: "bg-surface-text-selection-own",
        variable: "--surface-text-selection-own",
        pointsAt: "neutral-12 / accent ink at Buzzin’",
        use: "Neutral selection fill that contrasts with the outgoing bubble at either vibe.",
        status: "core",
      },
      {
        token: "bg-affordance-accent",
        variable: "--affordance-accent",
        pointsAt: "affordance-subtle (neutral compatibility role)",
        use: "A quiet compatibility fill; text selection uses surface-text-selection.",
        status: "core",
      },
      {
        token: "bg-affordance-mention",
        variable: "--affordance-mention",
        pointsAt: "black 10% light / white 16% dark",
        use: "Ordinary mention chip fill, paired with text-mention. Frequent, so it stays a neutral overlay that shows the bubble through.",
        status: "core",
      },
      {
        token: "bg-affordance-mention-hover",
        variable: "--affordance-mention-hover",
        pointsAt: "black 14% light / white 20% dark",
        use: "Mention chip under the pointer.",
        status: "core",
      },
      {
        token: "bg-affordance-mention-own",
        variable: "--affordance-mention-own",
        pointsAt:
          "affordance-mention; at Buzzin’, black 10% on the accent fill (16% on Magenta, Iris and Cobalt; white 16% on Mono in light mode)",
        use: "Mention chip fill inside your own bubble, paired with text-mention-own.",
        status: "core",
      },
      {
        token: "bg-affordance-mention-own-hover",
        variable: "--affordance-mention-own-hover",
        pointsAt:
          "affordance-mention-hover; at Buzzin’, black 14% on the accent fill (22% on Magenta, Iris and Cobalt; white 20% on Mono in light mode)",
        use: "Own-bubble mention chip under the pointer.",
        status: "core",
      },
      {
        token: "bg-affordance-mention-self",
        variable: "--affordance-mention-self",
        pointsAt: "affordance-accent-prominent",
        use: "Chip fill for a mention of you, paired with text-mention-self.",
        status: "core",
      },
      {
        token: "bg-affordance-mention-self-hover",
        variable: "--affordance-mention-self-hover",
        pointsAt: "affordance-accent-prominent-hover",
        use: "A mention of you under the pointer.",
        status: "core",
      },
      {
        token: "bg-affordance-accent-hover",
        variable: "--affordance-accent-hover",
        pointsAt: "affordance-subtle-hover (neutral compatibility role)",
        use: "A quiet identity fill under a pointer.",
        status: "core",
      },
      {
        token: "bg-affordance-accent-prominent",
        variable: "--affordance-accent-prominent",
        pointsAt: "accent step 9",
        use: "An identity accent fill paired with text-on-accent.",
        status: "core",
      },
      {
        token: "bg-affordance-accent-prominent-hover",
        variable: "--affordance-accent-prominent-hover",
        pointsAt: "accent step 10, each accent's hover",
        use: "An identity accent fill under a pointer.",
        status: "core",
      },
      {
        token: "bg-affordance-accent-prominent-pressed",
        variable: "--affordance-accent-prominent-pressed",
        pointsAt: "accent pressed fill",
        use: "An identity accent fill while pressed, such as an accent swatch.",
        status: "core",
      },
    ],
  },

  {
    id: "terminal-art",
    name: "Terminal artwork",
    description: "Warm palette endpoints for the decorative terminal welcome.",
    roles: [
      {
        token: "art-terminal-start",
        variable: "--art-terminal-start",
        pointsAt: "orange 9",
        use: "The orange endpoint of terminal welcome lettering.",
        status: "proposed",
        owner: "Terminal",
      },
      {
        token: "art-terminal-end",
        variable: "--art-terminal-end",
        pointsAt: "amber 9",
        use: "The amber endpoint of terminal welcome lettering.",
        status: "proposed",
        owner: "Terminal",
      },
    ],
  },
  {
    id: "surfaces",
    name: "Structural surfaces",
    description:
      "Compatibility aliases forward to semantic surface roles. New screens use surface-base, surface-panel and surface-popover directly.",
    roles: [
      {
        token: "bg-app",
        variable: "--bg-app",
        pointsAt: "neutral-quiet-hover light / neutral 2 dark",
        use: "Solid app shell below opaque panes. Its dot texture derives from this color in both modes.",
        status: "core",
      },
      {
        token: "bg-panel",
        variable: "--bg-panel",
        pointsAt: "neutral 1 light / neutral 3 dark",
        use: "An opaque content surface on the backdrop, including navigation, panels, and timelines.",
        status: "core",
      },
      {
        token: "bg-float",
        variable: "--bg-float",
        pointsAt: "neutral 1 light / neutral 5 dark",
        use: "A raised surface for menus, dialogs, and popups. Shares the panel fill in light mode and uses a lighter fill in dark mode.",
        status: "core",
      },
    ],
  },
  {
    id: "emphasis",
    name: "Emphasis",
    description:
      "Compatibility names for primary text, supporting text, metadata, and quiet borders. Disabled is a separate state.",
    roles: [
      {
        token: "text-primary",
        variable: "--text-primary",
        pointsAt: "text-standard",
        use: "Normal reading text.",
        status: "core",
      },
      {
        token: "text-secondary",
        variable: "--text-secondary",
        pointsAt: "neutral 10",
        use: "Supporting text: author names, labels.",
        status: "core",
      },
      {
        token: "text-tertiary",
        variable: "--text-tertiary",
        pointsAt: "neutral 9",
        use: "Metadata: timestamps, counts, hints.",
        status: "core",
      },
      {
        token: "text-disabled",
        variable: "--text-disabled",
        pointsAt: "neutral 8",
        use: "Text on unavailable controls. Do not use for information people need to read.",
        status: "core",
      },
      {
        token: "border-primary",
        variable: "--border-primary",
        pointsAt: "neutral 4",
        use: "Quiet panel boundaries and dividers. Use semantic control or state borders where the boundary must identify an interaction.",
        status: "core",
      },
    ],
  },
  {
    id: "material",
    name: "Material",
    description:
      "Apply glass-primary or glass-secondary as a complete material: fill, blur, rim, and optional shadow. Primary sits on the backdrop; secondary sits over glass. These underlying fills are not standalone Tailwind color utilities.",
    roles: [
      {
        token: "media-glass",
        variable: "--bg-media-glass",
        pointsAt: "black 35% + 24px blur + 150% saturation",
        use: "Floating video-preview controls in either app mode; static fill during hover and press.",
        status: "core",
      },
      {
        token: "border-image",
        variable: "--border-image",
        pointsAt: "black 10% in light; white 10% in dark",
        use: "A 1px outer hairline that separates message images and videos from their surroundings.",
        status: "core",
      },
      {
        token: "media-canvas",
        variable: "--bg-media-canvas",
        pointsAt: "#000000 in both modes",
        use: "Pure-black canvas behind fullscreen images and videos, separate from viewer chrome.",
        status: "core",
      },
      {
        token: "media-track",
        variable: "--bg-media-track",
        pointsAt: "white 16%",
        use: "The unplayed portion of media sliders over dark controls and video glass.",
        status: "core",
      },
      {
        token: "border-media-glass",
        variable: "--border-media-glass",
        pointsAt: "white 10%",
        use: "The continuous rim of the media-glass material.",
        status: "core",
      },
      {
        token: "text-on-media",
        variable: "--text-on-media",
        pointsAt: "white in both modes",
        use: "Icons and labels paired with the fixed dark media-glass fill.",
        status: "core",
      },
      {
        token: "glass-primary",
        variable: "--bg-glass-primary",
        pointsAt: "glass 2 + blur-md + rim",
        use: "Primary glass for surfaces with content behind them. Shell navigation uses flat chrome instead.",
        status: "core",
      },
      {
        token: "glass-secondary",
        variable: "--bg-glass-secondary",
        pointsAt: "glass 4 + blur-lg + rim + shadow-sm",
        use: "Secondary glass above another glass surface. A more opaque fill and shadow separate the layers.",
        status: "core",
      },
      {
        token: "bg-chrome-selected",
        variable: "--bg-chrome-selected",
        pointsAt: "surface-panel light / neutral 5 dark",
        use: "A flat shell selection: pane-colored in light mode, raised above hover in dark. Tab and route groups share a subtle capsule; standalone icons stay unfilled.",
        status: "core",
      },
      {
        token: "glass-primary-interactive",
        variable: "--bg-glass-primary-hover",
        pointsAt: "glass 3 on hover",
        use: "Interactive primary glass for chrome controls. Hover increases the fill by one step; blur stays fixed.",
        status: "core",
      },
    ],
  },
];

/* ============================================================
   THE VOCABULARY
   Every token in the system is built from these words. A new name
   combining existing words is routine; a new WORD is what the
   audit reports on its own line.
   ============================================================ */

export const VOCABULARY: Array<{ group: string; words: string[] }> = [
  { group: "property", words: ["bg", "text", "border", "ring"] },
  { group: "region", words: ["app", "panel", "float", "chrome", "inset"] },
  { group: "emphasis", words: ["primary", "secondary", "tertiary", "default"] },
  {
    group: "state",
    words: ["hover", "pressed", "selected", "disabled", "loading"],
  },
  { group: "material", words: ["glass"] },
  { group: "modifier", words: ["tint"] },
  { group: "identity", words: ["accent", "inverse"] },
  // Not a status vocabulary: `error` names one situation that needed a colour,
  // and `agent-running` names another. A tier vocabulary is what produced four
  // undesigned identities, so these stay concrete until a pattern repeats.
  { group: "situation", words: ["error", "agent-running"] },
  { group: "paired", words: ["on-accent", "on-inverse"] },
];

export const GRAMMAR =
  "color / <surface | text | border | affordance> / <purpose> [/ state]";

/** Fixed order, so there is only one correct spelling. */
export const GRAMMAR_EXAMPLES = {
  legal: ["bg-surface-panel", "text-standard", "bg-affordance-subtle-hover"],
  illegal: ["bg-chrome-hover-glass", "bg-hover-chrome"],
};

/** Steps for proposing a token change; use the repository review workflow. */
export const GROWTH_PROCEDURE = [
  "Find an existing role that serves the same purpose.",
  "For a required state, add the -hover, -selected, or -disabled sibling with light and dark values.",
  "For a required glass variant, add paired fills and its blur token through the shared material recipe.",
  "For a new role, add its name, both values, a one-sentence purpose, and an owner.",
  "For a new hue, define its palette ramp and point semantic roles at the steps. Keep raw values in the palette.",
  "Reuse vocabulary where it fits. Explain a new term so it can be reviewed as a shared decision.",
  "Do not add raw values above the palette. Document any required exception with its reason.",
];

/* ============================================================
   TYPOGRAPHY
   ============================================================ */

/** A public type role. Carries its whole setting, because size, line height,
 *  tracking, and weight are one decision rather than four. */
export interface TypeRole {
  /** The Tailwind class, e.g. `text-body`. */
  token: string;
  /** Semantic role represented by this utility. */
  pointsAt: string;
  /** Rendered size at the default preference and zoom, for display only —
   *  never a value a component may use. */
  size: string;
  lineHeight: string;
  tracking: string;
  weight: string;
  /** One sentence: when to use this. */
  use: string;
  status: TokenStatus;
  /** Set when the role renders in the mono face. */
  mono?: boolean;
}

/** Ordered loudest to quietest, which is also the order they are chosen in. */
export const TYPE_ROLES: TypeRole[] = [
  {
    token: "text-display",
    pointsAt: "display/hero",
    size: "56px",
    lineHeight: "1.1 (61.6px at default)",
    tracking: "-0.04em",
    weight: "400",
    use: "Expressive welcome or hero.",
    status: "core",
  },
  {
    token: "text-title",
    pointsAt: "display/page-title",
    size: "32px",
    lineHeight: "1.1 (35.2px at default)",
    tracking: "-0.015em",
    weight: "500",
    use: "Screen title.",
    status: "core",
  },
  {
    token: "text-heading",
    pointsAt: "display/section-title",
    size: "24px",
    lineHeight: "1.1 (26.4px at default)",
    tracking: "-0.0075em",
    weight: "500",
    use: "Content section title.",
    status: "core",
  },
  {
    token: "text-body-lg",
    pointsAt: "body/body-large",
    size: "20px",
    lineHeight: "28px",
    tracking: "-0.01em",
    weight: "400",
    use: "Lead paragraph.",
    status: "core",
  },
  {
    token: "text-body",
    pointsAt: "body/body-medium (Buzz 14px override)",
    size: "14px",
    lineHeight: "20px",
    tracking: "-0.005em",
    weight: "400",
    use: "Interface reading text.",
    status: "core",
  },
  {
    token: "text-body-sm",
    pointsAt: "body/body-small",
    size: "14px",
    lineHeight: "20px",
    tracking: "-0.0025em",
    weight: "400",
    use: "Supporting or dense reading text.",
    status: "core",
  },
  {
    token: "text-message",
    pointsAt: "body/message",
    size: "14px",
    lineHeight: "1.5714285714285714 (22px at default)",
    tracking: "-0.0025em",
    weight: "400",
    use: "Sent and received message prose, with compact line spacing.",
    status: "core",
  },
  {
    token: "text-label",
    pointsAt: "body/label-medium",
    size: "16px",
    lineHeight: "24px",
    tracking: "0em",
    weight: "500",
    use: "Controls and panel titles.",
    status: "core",
  },
  {
    token: "text-label-sm",
    pointsAt: "body/label-small",
    size: "14px",
    lineHeight: "20px",
    tracking: "0.0025em",
    weight: "500",
    use: "Compact controls and row labels.",
    status: "core",
  },
  {
    token: "text-caption",
    pointsAt: "detail/caption",
    size: "12px",
    lineHeight: "16px",
    tracking: "0.0133em",
    weight: "400",
    use: "Timestamps and metadata.",
    status: "core",
  },
  {
    token: "text-mono-lg",
    pointsAt: "detail/body-xsmall",
    size: "12px",
    lineHeight: "16px",
    tracking: "0.03em",
    weight: "400",
    use: "Compatibility alias for text-mono; use text-mono in new code.",
    status: "core",
    mono: true,
  },
  {
    token: "text-mono",
    pointsAt: "detail/body-xsmall",
    size: "12px",
    lineHeight: "16px",
    tracking: "0.03em",
    weight: "400",
    use: "Code and identifiers.",
    status: "core",
    mono: true,
  },
  {
    token: "text-mono-sm",
    pointsAt: "detail/body-xsmall",
    size: "12px",
    lineHeight: "16px",
    tracking: "0.03em",
    weight: "400",
    use: "Compatibility alias for text-mono; use text-mono in new code.",
    status: "core",
    mono: true,
  },
];

/** Font families used by the type roles. */
export const TYPE_FAMILIES = [
  {
    token: "font-sans",
    name: "Inter Variable",
    use: "Interface, labels and reading text.",
  },
  {
    token: "font-mono",
    name: "JetBrains Mono",
    use: "Code, keys and identifiers, set in the xsmall detail role at 12/16.",
  },
];

/** Active size primitives, with xsmall sharing the 12px step. */
export const TYPE_RAMPS = [
  {
    id: "size",
    name: "Size",
    description:
      "Thirteen size steps. Caption and xsmall detail both use 12px, with separate semantic tokens so each can evolve independently. Values shown at 100% text size.",
    steps: [
      {
        step: 12,
        value: "12px",
        job: "caption and xsmall detail",
      },
      {
        step: 14,
        value: "14px",
        job: "small body and labels",
      },
      {
        step: 16,
        value: "16px",
        job: "body and labels",
      },
      {
        step: 18,
        value: "18px",
        job: "Primitive only; no role assigned.",
      },
      {
        step: 20,
        value: "20px",
        job: "large body",
      },
      {
        step: 24,
        value: "24px",
        job: "section title",
      },
      {
        step: 28,
        value: "28px",
        job: "Primitive only; no role assigned.",
      },
      {
        step: 32,
        value: "32px",
        job: "page title",
      },
      {
        step: 36,
        value: "36px",
        job: "Primitive only; no role assigned.",
      },
      {
        step: 44,
        value: "44px",
        job: "Primitive only; no role assigned.",
      },
      {
        step: 56,
        value: "56px",
        job: "hero",
      },
      {
        step: 72,
        value: "72px",
        job: "Primitive only; no role assigned.",
      },
      {
        step: 96,
        value: "96px",
        job: "Primitive only; no role assigned.",
      },
    ],
  },
  {
    id: "weight",
    name: "Weight",
    description: "400 for reading, 500 for labels and structure.",
    steps: [
      { step: 400, job: "reading", value: "400" },
      { step: 500, job: "structure", value: "500" },
    ],
  },
];

export const SPACE = [
  {
    step: 0.5,
    variable: "--space-half",
    value: "2px",
    use: "Compact control inset.",
  },
  {
    step: 1.5,
    variable: "--space-1h",
    value: "6px",
    use: "Compact control gap.",
  },
  {
    step: 1,
    variable: "--space-1",
    value: "4px",
    use: "Tight optical separation inside a control.",
  },
  {
    step: 2,
    variable: "--space-2",
    value: "8px",
    use: "The panel gap and default gap between related items.",
  },
  {
    step: 3,
    variable: "--space-3",
    value: "12px",
    use: "The horizontal inset inside rows and compact controls.",
  },
  {
    step: 4,
    variable: "--space-4",
    value: "16px",
    use: "The workspace edge and ordinary content inset.",
  },
  {
    step: 5,
    variable: "--space-5",
    value: "20px",
    use: "The inset of a full panel header or reading surface.",
  },
  {
    step: 6,
    variable: "--space-6",
    value: "24px",
    use: "Separation between distinct content groups.",
  },
  { step: 8, variable: "--space-8", value: "32px", use: "Content groups." },
  { step: 16, variable: "--space-16", value: "64px", use: "Page sections." },
];

export const SPACE_ROLES = [
  {
    token: "space-page-section-gap",
    variable: "--space-page-section-gap",
    pointsAt: "space 16",
    use: "Separation between page sections.",
  },
  {
    token: "space-workspace-inset",
    variable: "--space-workspace-inset",
    pointsAt: "space 4",
    use: "The distance between the window edge and its panels.",
  },
  {
    token: "space-panel-gap",
    variable: "--space-panel-gap",
    pointsAt: "space 2",
    use: "The seam between independently movable panels.",
  },
  {
    token: "space-panel-inset",
    variable: "--space-panel-inset",
    pointsAt: "space 6",
    use: "The horizontal inset inside a full panel.",
  },
  {
    token: "space-control-inset",
    variable: "--space-control-inset",
    pointsAt: "space 4",
    use: "The horizontal inset inside controls and navigation rows.",
  },
  {
    token: "space-row-gap",
    variable: "--space-row-gap",
    pointsAt: "space 2",
    use: "The gap between an icon, label, and trailing metadata in one row.",
  },
  {
    token: "space-section-gap",
    variable: "--space-section-gap",
    pointsAt: "space 8",
    use: "The gap between related sections. Keep it larger than the spacing within each group.",
  },
];

export const RADII = [
  {
    token: "radius-chip",
    variable: "--radius-chip",
    value: "12px",
    use: "Small chips and tight details.",
  },
  {
    token: "radius-row",
    variable: "--radius-row",
    value: "16px",
    use: "Dense navigator rows, compact selected regions and compact floating surfaces.",
  },
  {
    token: "radius-icon-button",
    variable: "--radius-icon-button",
    value: "18px",
    use: "Independent icon controls, including top-bar and content-toolbar actions, with the same radius on every corner.",
  },
  {
    token: "radius-control",
    variable: "--radius-control",
    value: "20px",
    use: "Inputs, rounded cue buttons and the message action toolbar. Icon controls use radius-icon-button; text buttons default to radius-capsule.",
  },
  {
    token: "radius-container",
    variable: "--radius-container",
    value: "24px",
    use: "Medium containers, including menus, content popovers, pickers and the media review frame.",
  },
  {
    token: "radius-panel",
    variable: "--radius-panel",
    value: "28px",
    use: "Major workspace panels and dialogs. Maximum standalone container radius.",
  },
  {
    token: "radius-capsule",
    variable: "--radius-capsule",
    value: "34px",
    use: "Text buttons and similarly sized actions: capsule-shaped through 68px, bounded on taller controls.",
  },
  {
    token: "radius-pill",
    variable: "--radius-pill",
    value: "round",
    use: "Pills, menu rows, avatars, and fully circular controls.",
  },
];

export const MOTION = [
  {
    token: "duration-panel-enter",
    variable: "--duration-panel-enter",
    value: "180ms",
    use: "An occasional pointer-opened overlay panel entering from the edge.",
  },
  {
    token: "easing-enter",
    variable: "--easing-enter",
    value: "cubic-bezier(.23,1,.32,1)",
    use: "Responsive entrances and exits with immediate initial movement.",
  },
  {
    token: "duration-fast",
    variable: "--duration-fast",
    value: "120ms",
    use: "A hover affordance appearing or disappearing.",
  },
  {
    token: "duration-state",
    variable: "--duration-state",
    value: "150ms",
    use: "A colour or opacity state changing in place.",
  },
  {
    token: "duration-settle",
    variable: "--duration-settle",
    value: "220ms",
    use: "A tab indicator or released panel settling into place.",
  },
  {
    token: "easing-state",
    variable: "--easing-state",
    value: "ease",
    use: "Small state changes that do not move geometry.",
  },
  {
    token: "easing-settle",
    variable: "--easing-settle",
    value: "cubic-bezier(.645,.045,.355,1)",
    use: "Geometry settling after a deliberate selection or release.",
  },
];

export const ELEVATION = [
  {
    token: "shadow-panel",
    variable: "--shadow-panel",
    use: "Workspace panels and floating surfaces: translucent contour and subtle lift; a quiet light rim in dark mode.",
  },
  {
    token: "shadow-xs",
    variable: "--shadow-xs",
    use: "The default lift: a selected pill, a small raised control.",
  },
  {
    token: "shadow-sm",
    variable: "--shadow-sm",
    use: "Ordinary elevation for bordered dialogs, tooltips, and raised controls.",
  },
];

export const BLUR = [
  { token: "blur-sm", variable: "--blur-sm", value: "8px" },
  { token: "blur-md", variable: "--blur-md", value: "16px" },
  { token: "blur-lg", variable: "--blur-lg", value: "32px" },
];

/** The entire exception list. Everything else points at a ramp step. */
export const EXCEPTIONS = [
  {
    name: "--bg-media-glass, --border-media-glass, --text-on-media, --bg-media-track",
    why: "Media preview glass remains black at 35% with a white 10% rim and white icons in either app mode; the unplayed track remains white at 16%. These paired values preserve the video beneath it.",
  },
  {
    name: "text-on-accent, text-on-inverse, and the four status pairings",
    why: "Computed from the fill’s lightness so text remains paired with the selected accent or status color.",
  },
  {
    name: "--rim-lit, --rim-shade",
    why: "The glass rim models directional light independently of its fill. In dark mode, translucent white rim values remain distinct from the near-black glass fill.",
  },
  {
    name: "legacy backdrop treatments and gradient-1…4",
    why: "Kept for the viewer’s glass study only, not product themes. The app shell is solid.",
  },
  {
    name: "texture-dots",
    why: "The shared decorative texture derives its color from bg-app: a darker shade in light mode and a lighter tint in dark. Never give dots an independent gray or paint the pattern inside reading panes.",
  },
];
