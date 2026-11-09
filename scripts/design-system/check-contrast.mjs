#!/usr/bin/env node
/**
 * Fails the build when a text role cannot be read on a surface it is used on.
 *
 * This exists because the token table found four broken pairings by rendering
 * them, and a defect found by looking is a defect that ships until someone
 * looks. The table stays as the readable view; this is the check that runs.
 *
 * It parses `tokens.css` rather than a duplicate list of values, so it cannot
 * drift from the system it audits: resolve each role through its `var()` chain
 * to a literal, per mode, then measure every pairing the roles allow.
 *
 * Text clears APCA and WCAG AA, per DESIGN.md § Contrast. Control/state boundaries use the
 * separate WCAG 3:1 non-text target on their supported opaque surfaces.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { apcaContrast, wcagRatio } from "./apca.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TOKENS = join(ROOT, "src/shared/design-system/styles/tokens.css");

/** Body text. Anything a person must read to use the product. */
const TARGET_BODY = 60;
/** Metadata keeps its APCA target and still clears WCAG AA at its small size. */
const TARGET_META = 45;

/**
 * Pairings that are deliberately below target, with the reason.
 *
 * An exception must name a role and say why, so the list stays short and
 * arguable rather than becoming a place to hide failures.
 *
 * A key is either a role — exempt on every surface — or `role on surface`,
 * exempt for that one pairing. Prefer the narrow form: a role-wide exemption
 * for a shortfall on one surface also silences a genuine failure on the next
 * surface that role reaches, which is the failure mode this list must not have.
 */
const EXCEPTIONS = new Map([
  // Product-directed 2026-10-01: Green 10 / Red 10 incoming-call fills.
  ...[
    "affordance-call-join",
    "affordance-call-join-hover",
    "affordance-call-decline",
    "affordance-call-decline-hover",
  ].map((surface) => [
    `--text-inverse on --${surface}`,
    "Product-directed bright incoming-call fills with inverse labels; below normal text targets, limited to Join and Decline.",
  ]),
  // Kenneth requested Red 10 for Huddle Leave during the 2026-10-01 tryout.
  // Limit this deliberate text-contrast tradeoff to the actual control fills.
  ...[
    "surface-panel",
    "affordance-subtle-hover",
    "affordance-subtle-pressed",
    "affordance-danger",
    "affordance-danger-hover",
    "affordance-danger-pressed",
  ].map((surface) => [
    `--text-call-leave on --${surface}`,
    "Product-directed Red 10 for the Huddle Leave label/icon; below normal text targets, not approved for general error text.",
  ]),
  [
    "--text-disabled",
    "Low contrast is the signal that a control is unavailable; WCAG exempts inactive controls. Never carries information a person needs.",
  ],
]);

// Designer-approved removal of the Away outline; see DESIGN.md § Identity shapes.
// Bind each exception to the exact mode, role, fill and surface color.
const ACCEPTED_AWAY_PAIRS = new Set([
  "light --status-away #ffba18 on --surface-base #f5f5f6",
  "light --status-away #ffba18 on --surface-panel #ffffff",
  "light --status-away #ffba18 on --surface-inset #f5f5f6",
  "light --status-away #ffba18 on --surface-popover #ffffff",
  "light --status-away #ffba18 on --affordance-selected #e8e8e8",
  "light --status-away #ffba18 on --affordance-panel-hover #f5f5f6",
  "light --status-away #ffba18 on --affordance-subtle-hover #f1f1f2",
  "light --status-away #ffba18 on --affordance-floating-hover #f5f5f6",
  "light --status-away #ffba18 on --neutral-4 #dadada",
]);
const acceptedAwayMeasurements = new Map();

/** Roles measured at the meta target rather than the body target. */
const META_ROLES = new Set([
  "--text-tertiary",
  "--text-metadata",
  "--text-metadata-own",
  "--text-row-metadata",
  "--text-row-selected-metadata",
]);

/**
 * Neutral surfaces any text may sit on.
 *
 * `--bg-hover` was a role and is now written as `--neutral-4`, so it is named by
 * its step here. It still belongs in this list: a row under the cursor is a
 * surface text sits on, whatever it is called.
 */
const SURFACES = [
  "--surface-base",
  "--surface-panel",
  "--surface-popover",
  "--surface-inset",
  "--affordance-subtle",
  "--affordance-selected",
  "--affordance-panel-hover",
  "--affordance-subtle-hover",
  "--affordance-floating-hover",
  "--neutral-4",
];

/**
 * Text that must be readable on every neutral surface.
 *
 * **The palette steps in this list are the point, not an oversight.** Once a
 * screen may write `text-red-12` directly, the guard has to measure the step a
 * screen actually uses — otherwise it audits names nobody types. `--text-error`
 * and `--text-accent` used to be here; deleting the roles without moving their
 * steps into this list would have left the guard passing while measuring
 * nothing, which is precisely the failure that shipped error text at Lc 34.
 *
 * A step joins this list when a screen starts using it for text. `red-12` is
 * here because three error messages use it; `red-11` is not, because nothing
 * does — and it is the step that fails, at 59.7 on a dark panel.
 */
const TEXT_ROLES = [
  "--text-standard",
  "--text-subtle",
  "--text-metadata",
  "--text-danger",
  "--text-warning",
  "--text-success",
  "--text-accent",
  "--text-link",
  "--text-primary",
  "--text-secondary",
  "--text-tertiary",
  "--text-disabled",
  "--purple-12", // accent text: links, active nav, chip labels
  "--red-12", // error text: failed session start, rejected form
  "--amber-12", // warning text in delivery notices and dialogs
  "--green-12", // success text
];

/**
 * Paired text and the fills it is defined against — including each fill's hover.
 *
 * The hover was the gap. A solid button had no `bg-*-hover`, so hovering one
 * fell through to the neutral `bg-hover` and painted white paired text on light
 * grey — Lc 13, invisible, and this guard could not see it because it only
 * measured the resting fill. A paired text colour is only correct if it clears
 * every fill it can actually sit on, and hover is one of them.
 */
const PAIRS = [
  ["--text-control-selected", "--surface-control-selected"],
  ...[
    "affordance-call-join",
    "affordance-call-join-hover",
    "affordance-call-decline",
    "affordance-call-decline-hover",
  ].map((surface) => ["--text-inverse", `--${surface}`]),
  ...[
    "surface-panel",
    "affordance-subtle-hover",
    "affordance-subtle-pressed",
    "affordance-danger",
    "affordance-danger-hover",
    "affordance-danger-pressed",
  ].map((surface) => ["--text-call-leave", `--${surface}`]),
  ...["--text-standard", "--text-subtle", "--text-metadata"].map((role) => [
    role,
    "--bg-app",
  ]),
  ["--text-standard", "--affordance-popover-selected"],
  ...["--affordance-chrome", "--affordance-chrome-hover"].flatMap((fill) => [
    ["--text-chrome-subtle", fill],
    ["--text-standard", fill],
  ]),
  ...["--affordance-row-hover", "--affordance-selected"].flatMap((fill) => [
    ["--text-row", fill],
    ["--text-navigation-unread", fill],
    ["--text-row-subtle", fill],
    ["--text-row-metadata", fill],
  ]),
  // The selected sidebar destination and every ink on it.
  ...[
    "--text-row-selected",
    "--text-row-selected-subtle",
    "--text-row-selected-metadata",
  ].map((role) => [role, "--affordance-navigation-selected"]),
  // Small status/count badges on a selected row keep their own readable pair.
  ["--text-row-selected-detail", "--surface-row-selected-detail"],
  ["--text-subtle", "--affordance-popover-selected"],
  ...["control", "control-hover", "control-pressed", "selected"].map(
    (state) => ["--text-standard", `--affordance-floating-${state}`],
  ),
  ["--text-standard", "--affordance-floating-hover"],
  ["--text-danger", "--affordance-floating-hover"],
  ["--text-inverse", "--surface-inverse"],
  ["--text-on-status-success", "--surface-status-success"],
  ["--text-on-status", "--surface-status-danger"],
  ["--text-link", "--affordance-link-hover"],
  // Mentions: ink on the highlight, and the own-bubble pairing, at rest and hover.
  ...["", "-hover"].flatMap((state) => [
    ["--text-mention", `--affordance-mention${state}`],
    ["--text-mention-own", `--affordance-mention-own${state}`],
    ["--text-mention-self", `--affordance-mention-self${state}`],
  ]),
  // Reaction counts sit on the strip overlay, and your whole bubble takes a
  // quieter overlay under the pointer.
  ["--text-standard", "--affordance-reaction"],
  ["--text-message-own", "--affordance-reaction-own"],
  ["--text-reaction-self", "--affordance-reaction-self"],
  ["--text-reaction-self-own", "--affordance-reaction-self-own"],
  ["--text-message-own", "--affordance-message-own-hover"],
  // An arrival cue lays the regular step across the whole bubble.
  ["--text-standard", "--affordance-message-highlight"],
  ["--text-message-own", "--affordance-message-own-highlight"],
  ...["subtle", "subtle-hover", "subtle-pressed"].map((state) => [
    "--text-standard",
    `--affordance-${state}`,
  ]),
  ...["prominent", "prominent-hover", "prominent-pressed"].map((state) => [
    "--text-on-prominent",
    `--affordance-${state}`,
  ]),
  ...["danger", "danger-hover", "danger-pressed"].map((state) => [
    "--text-danger",
    `--affordance-${state}`,
  ]),
  // `bg-neutral-11` with `text-neutral-1` — the inverse pair, written as steps
  // now that the roles are gone. Still measured as a pair, because the text
  // follows the fill: move the fill and this has to be re-measured.
  ["--neutral-1", "--neutral-11"],
  ["--neutral-1", "--neutral-12"],
];

/**
 * Tint surfaces and the coloured text that sits on them, as steps.
 *
 * DESIGN.md: "tint carries a meaning and takes coloured text". The accent tint
 * and its hover are both real surfaces — a chip at rest and a chip under the
 * cursor — and the hover is the harder one, which is where the gap was.
 */
const BOUNDARY_SURFACES = [
  "--surface-base",
  "--surface-panel",
  "--surface-inset",
  "--surface-popover",
];
/**
 * State icons that also sit inside message bubbles: a pull request link's
 * glyph and the sidebar's. Each is measured against the received bubble, and
 * its `-own` pair against the own bubble, per accent family and level below.
 * On the high level the own bubble is the solid accent step, which neither
 * grey nor any one hue clears on every family, so there the `-own` pair is the
 * bubble's link ink.
 */
const MESSAGE_ICON_ROLES = [
  "--icon-subtle",
  "--icon-success",
  "--icon-categorical-purple",
];
const BOUNDARY_ROLES = [
  // Dots and insertion lines in the prominent color stand alone on a surface.
  "--affordance-prominent-mark",
  "--border-danger",
  "--border-warning",
  "--status-online",
  // Online retains its outline; Away now exposes the step-10 fill directly.
  "--status-avatar-online-border",
  "--status-away",
  "--status-offline",
  // Chart marks need 3:1 against the surfaces a chart sits on.
  "--chart-series-1",
  "--chart-series-2",
  "--chart-series-3",
  "--chart-series-4",
  ...MESSAGE_ICON_ROLES,
];

const TINT_PAIRS = [
  ["--text-warning", "--affordance-warning"],
  ["--text-success", "--affordance-success"],
  ["--text-success", "--affordance-success-hover"],
  ["--text-success", "--affordance-success-pressed"],
  ["--text-accent", "--affordance-accent"],
  ["--text-accent", "--affordance-accent-hover"],
  ["--text-on-accent", "--affordance-accent-prominent"],
  ["--text-on-accent", "--affordance-accent-prominent-hover"],
  ["--amber-12", "--amber-3"],
  ["--green-12", "--green-3"],
  ["--purple-12", "--purple-3"],
  ["--purple-12", "--purple-4"],
];

const css = readFileSync(TOKENS, "utf8");
const DEFAULT_ACCENT = "citrus";
/** Exceptions are approved against the neutral role layer. */
const BASELINE_LEVEL = "neutral";

/**
 * Collects declarations per mode, honouring source order so a later block wins
 * exactly as the cascade would. `.dark` inherits `:root` and overrides it, so
 * dark is light-then-dark rather than dark alone.
 */
function declarationsByMode(
  source = css,
  accent = DEFAULT_ACCENT,
  level = BASELINE_LEVEL,
) {
  const light = new Map();
  const dark = new Map();
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  // Top-level mode owners in cascade order, plus the selected accent family
  // and color level. The neutral level is the role layer without overrides.
  for (const [, selector, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const owner = selector.trim().split(/,\s*/).at(-1);
    if (
      owner !== ":root" &&
      owner !== ".dark" &&
      !/\[data-(?:accent|color-level)="/.test(selector)
    )
      continue;
    const family = /\[data-accent="([a-z]+)"\]/.exec(selector)?.[1];
    if (family && family !== accent) continue;
    const blockLevels = [
      ...selector.matchAll(/\[data-color-level="([a-z]+)"\]/g),
    ].map((match) => match[1]);
    if (blockLevels.length && !blockLevels.includes(level)) continue;
    // Dark starts from the light value and is overridden by dark owners.
    const isDark =
      owner.endsWith(".dark") || selector.includes('[data-color-mode="dark"]');
    for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
      if (!isDark) light.set(name, value.trim());
      dark.set(name, value.trim());
    }
  }
  return { light, dark };
}

/**
 * See-through fills and the message surface each is measured on. A chip overlay
 * is measured as the colour it makes there, which is what a reader sees. A
 * mention can also sit on the composer or a panel; those hosts are unmeasured.
 * A translucent role missing here stays unmeasurable and is reported, and a
 * listed role that does not resolve fails.
 */
const SITS_ON = new Map([
  ["--affordance-mention", "--surface-message"],
  ["--affordance-mention-hover", "--surface-message"],
  ["--affordance-mention-own", "--surface-message-own"],
  ["--affordance-mention-own-hover", "--surface-message-own"],
  ["--affordance-message-own-hover", "--surface-message-own"],
  ["--affordance-message-highlight", "--surface-message"],
  ["--affordance-message-own-highlight", "--surface-message-own"],
  ["--affordance-reaction", "--surface-message"],
  ["--affordance-reaction-own", "--surface-message-own"],
]);

/** `#rgb` or `#rrggbb` as three 0–255 channels. */
function channels(hex) {
  const digits =
    hex.length === 4
      ? [...hex.slice(1)].map((d) => d + d)
      : [1, 3, 5].map((i) => hex.slice(i, i + 2));
  return digits.map((d) => Number.parseInt(d, 16));
}

/**
 * Follows a `var()` chain to its literal, or null if it is not a plain colour.
 * An `rgb(r g b / a%)` overlay resolves only for a role in `SITS_ON`, as the
 * flat colour it composites to over its surface.
 */
function resolve(map, name, depth = 0, role = name) {
  if (depth > 10) return null;
  const value = map.get(name);
  if (!value) return null;
  const single = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
  if (single) return resolve(map, single[1], depth + 1, role);
  if (/^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/.test(value)) return value;
  const overlay = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)%\s*\)$/.exec(
    value,
  );
  const under = SITS_ON.has(role) ? resolve(map, SITS_ON.get(role)) : null;
  if (!overlay || !under) return null;
  const alpha = Number(overlay[4]) / 100;
  return `#${channels(under)
    .map((base, i) =>
      Math.round(Number(overlay[i + 1]) * alpha + base * (1 - alpha))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

const failures = [];
const boundaryFailures = [];
const skipped = [];
/**
 * Pairing-scoped exceptions this run actually needed. An exception nobody hits
 * is either fixed or wrong, and either way should not sit in the list
 * unchallenged — same reasoning as the type guard's stale-override report.
 */
const claimedExceptions = new Set();

/**
 * The Away badge is approved below 3:1 on the neutral surfaces listed above.
 * On a color level it may sit on accent surfaces instead; it is accepted
 * there only when it is no fainter than the faintest approved neutral pair.
 */
const levelAwayMeasurements = new Map();
function audit(mode, map, baseline) {
  const check = (textRole, surfaceRole) => {
    const text = resolve(map, textRole);
    const surface = resolve(map, surfaceRole);
    // A translucent or gradient value cannot be measured against one colour;
    // record it rather than passing it silently.
    if (!text || !surface) {
      // An overlay listed in SITS_ON is meant to be measurable, so a missing
      // token there is a defect, not a value the guard cannot read.
      if (SITS_ON.has(surfaceRole))
        boundaryFailures.push(
          `${mode}: unresolved overlay pair ${textRole} on ${surfaceRole}`,
        );
      else skipped.push(`${mode}: ${textRole} on ${surfaceRole}`);
      return;
    }
    const lc = Math.abs(apcaContrast(text, surface));
    const target = META_ROLES.has(textRole) ? TARGET_META : TARGET_BODY;
    const wcag = wcagRatio(text, surface);
    if (lc >= target && wcag >= 4.5) return;
    // Role-wide first, then the narrow `role on surface` form.
    if (EXCEPTIONS.has(textRole)) return;
    if (EXCEPTIONS.has(`${textRole} on ${surfaceRole}`)) {
      claimedExceptions.add(`${textRole} on ${surfaceRole}`);
      return;
    }
    failures.push({
      mode,
      textRole,
      text,
      surfaceRole,
      surface,
      lc,
      target,
      wcag: wcagRatio(text, surface),
    });
  };

  for (const role of TEXT_ROLES) {
    for (const surface of SURFACES) check(role, surface);
  }
  for (const [role, fill] of PAIRS) check(role, fill);
  for (const [text, tint] of TINT_PAIRS) check(text, tint);
  const floatingBorder = resolve(map, "--border-floating-control");
  const floatingSurface = resolve(map, "--surface-popover");
  const floatingBoundary =
    floatingBorder && floatingSurface
      ? wcagRatio(floatingBorder, floatingSurface)
      : null;
  if (floatingBoundary === null || floatingBoundary < 3) {
    boundaryFailures.push(
      `${mode}: --border-floating-control on --surface-popover — ${floatingBoundary === null ? "unresolved color" : `${floatingBoundary.toFixed(3)}:1`}, needs 3:1`,
    );
  }
  for (const role of BOUNDARY_ROLES) {
    const surfaces =
      role.startsWith("--status-avatar-") || role === "--status-away"
        ? [
            ...BOUNDARY_SURFACES,
            "--affordance-selected",
            "--affordance-panel-hover",
            "--affordance-subtle-hover",
            "--affordance-floating-hover",
            "--neutral-4",
          ]
        : role.startsWith("--chart-series-")
          ? // Charts sit on panels; a popover only shows a swatch beside its label.
            BOUNDARY_SURFACES.filter(
              (surface) => surface !== "--surface-popover",
            )
          : BOUNDARY_SURFACES;
    for (const surface of surfaces) {
      const borderColor = resolve(map, role);
      const surfaceColor = resolve(map, surface);
      const ratio =
        borderColor && surfaceColor
          ? wcagRatio(borderColor, surfaceColor)
          : null;
      const pair = `${mode} ${role} ${borderColor} on ${surface} ${surfaceColor}`;
      if (ratio !== null && ratio < 3 && ACCEPTED_AWAY_PAIRS.has(pair)) {
        acceptedAwayMeasurements.set(pair, ratio);
        continue;
      }
      if (
        !baseline &&
        role === "--status-away" &&
        ratio !== null &&
        ratio < 3 &&
        ratio >= approvedAwayFloor
      ) {
        levelAwayMeasurements.set(pair, ratio);
        continue;
      }
      if (ratio === null || ratio < 3) {
        boundaryFailures.push(
          `${mode}: ${role} on ${surface} — ${ratio === null ? "unresolved color" : `${ratio.toFixed(3)}:1`}, needs 3:1`,
        );
      }
    }
  }
}

for (const [mode, map] of Object.entries(declarationsByMode()))
  audit(mode, map, true);
const approvedAwayFloor = Math.min(...acceptedAwayMeasurements.values());
const LEVELS = [
  ...new Set(
    [...css.matchAll(/\[data-color-level="([a-z]+)"\]/g)].map((m) => m[1]),
  ),
];

// Every accent family must work, not only the default. Each family's text,
// ink and lines are measured where they appear; an unresolved value fails
// rather than silently falling outside the opaque-color audit.
const accentFamilies = [
  ...new Set(
    [...css.matchAll(/\[data-accent="([a-z]+)"\]/g)].map((match) => match[1]),
  ),
];
const ACCENT_PAIRS = [
  ["--text-on-selection", "--surface-text-selection"],
  ["--text-on-selection-own", "--surface-text-selection-own"],
  ["--text-sidebar-selected", "--surface-sidebar-selected"],
  ["--text-sidebar-hover", "--affordance-sidebar-hover"],
  ["--text-message-link", "--surface-message"],
  ["--text-standard", "--surface-message"],
  ["--text-navigation-selected", "--surface-navigation-selected"],
  ["--text-navigation-selected", "--bg-chrome-selected"],
  ...["", "-hover", "-pressed"].map((state) => [
    "--text-on-accent",
    `--affordance-accent-prominent${state}`,
  ]),
  ["--text-message-own", "--surface-message-own"],
  ["--text-message-link-own", "--surface-message-own"],
  ["--text-metadata", "--surface-message"],
  ["--text-metadata-own", "--surface-message-own"],
  ...["", "-hover", "-pressed"].map((state) => [
    "--text-on-prominent",
    `--affordance-prominent${state}`,
  ]),
  ...[...SURFACES, "--affordance-accent", "--affordance-accent-hover"].map(
    (surface) => ["--text-accent", surface],
  ),
  ...["--affordance-accent", "--affordance-accent-hover"].map((surface) => [
    "--text-standard",
    surface,
  ]),
];
for (const family of accentFamilies) {
  for (const level of [BASELINE_LEVEL, ...LEVELS]) {
    if (level !== BASELINE_LEVEL || family !== DEFAULT_ACCENT)
      for (const [mode, map] of Object.entries(
        declarationsByMode(css, family, level),
      ))
        audit(`${family}/${level}/${mode}`, map, false);
    for (const [mode, map] of Object.entries(
      declarationsByMode(css, family, level),
    )) {
      for (const [textRole, surfaceRole] of ACCENT_PAIRS) {
        const text = resolve(map, textRole);
        const surface = resolve(map, surfaceRole);
        if (!text || !surface) {
          boundaryFailures.push(
            `${family}/${level}/${mode}: unresolved accent pair ${textRole} on ${surfaceRole}`,
          );
          continue;
        }
        const lc = Math.abs(apcaContrast(text, surface));
        const target = META_ROLES.has(textRole) ? TARGET_META : TARGET_BODY;
        const wcag = wcagRatio(text, surface);
        if (lc < target || wcag < 4.5)
          failures.push({
            mode: `${family}/${level}/${mode}`,
            textRole,
            text,
            surfaceRole,
            surface,
            lc,
            target,
            wcag,
          });
      }
      for (const surfaceRole of [
        ...BOUNDARY_SURFACES,
        "--surface-message",
        "--surface-message-own",
        "--affordance-mention",
        "--affordance-mention-own",
      ]) {
        const selectionRole = surfaceRole.endsWith("-own")
          ? "--surface-text-selection-own"
          : "--surface-text-selection";
        const selection = resolve(map, selectionRole);
        const surface = resolve(map, surfaceRole);
        const ratio =
          selection && surface ? wcagRatio(selection, surface) : null;
        if (ratio === null || ratio < 3)
          boundaryFailures.push(
            `${family}/${level}/${mode}: ${selectionRole} on ${surfaceRole} — ${ratio === null ? "unresolved color" : `${ratio.toFixed(3)}:1`}, needs 3:1`,
          );
      }
      for (const surfaceRole of BOUNDARY_SURFACES) {
        const border = resolve(map, "--border-accent");
        const surface = resolve(map, surfaceRole);
        const ratio = border && surface ? wcagRatio(border, surface) : null;
        if (ratio === null || ratio < 3)
          boundaryFailures.push(
            `${family}/${level}/${mode}: --border-accent on ${surfaceRole} — ${ratio === null ? "unresolved color" : `${ratio.toFixed(3)}:1`}, needs 3:1`,
          );
      }
      for (const baseRole of MESSAGE_ICON_ROLES) {
        for (const [role, surfaceRole] of [
          [baseRole, "--surface-message"],
          [`${baseRole}-own`, "--surface-message-own"],
        ]) {
          const icon = resolve(map, role);
          const surface = resolve(map, surfaceRole);
          const ratio = icon && surface ? wcagRatio(icon, surface) : null;
          if (ratio === null || ratio < 3)
            boundaryFailures.push(
              `${family}/${level}/${mode}: ${role} on ${surfaceRole} — ${ratio === null ? "unresolved color" : `${ratio.toFixed(3)}:1`}, needs 3:1`,
            );
        }
      }
    }
  }
}

// Gray never sits on an accent ground. A role that stays gray while the
// background beneath it turned accent is a missing color group, not a style
// to patch locally. Near-black and near-white ink are not gray.
function oklch(hex) {
  const [r, g, b] = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return {
    lightness: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    chroma: Math.hypot(a, bb),
  };
}
const isAccent = (hex) => oklch(hex).chroma >= 0.02;
// Black ink is allowed on accent fills, including the near-black unread ink
// (#262626, lightness 0.27); mid grays from #525252 (0.44) up are not.
const isGray = (hex) => {
  const { lightness, chroma } = oklch(hex);
  return chroma < 0.02 && lightness > 0.3 && lightness < 0.9;
};
const on = (foregrounds, grounds) =>
  grounds.flatMap((ground) => foregrounds.map((fg) => [fg, ground]));
const GROUNDED = [
  ["--text-sidebar-selected", "--surface-sidebar-selected"],
  ["--text-sidebar-hover", "--affordance-sidebar-hover"],
  ["--text-navigation-selected", "--surface-navigation-selected"],
  ["--text-navigation-selected", "--bg-chrome-selected"],
  ...on(
    [
      "--text-standard",
      "--text-row",
      "--text-navigation-unread",
      "--text-row-subtle",
      "--text-row-metadata",
    ],
    [
      "--affordance-row-hover",
      "--affordance-panel-hover",
      "--affordance-navigation-quiet",
      "--affordance-selected",
    ],
  ),
  ...on(
    [
      "--text-row-selected",
      "--text-row-selected-subtle",
      "--text-row-selected-metadata",
    ],
    ["--affordance-navigation-selected"],
  ),
  ...on(
    ["--text-standard"],
    [
      "--affordance-floating-hover",
      "--affordance-popover-selected",
      "--affordance-floating-selected",
    ],
  ),
  ...on(
    [
      "--text-standard",
      "--text-subtle",
      "--text-metadata",
      "--border-prominent",
      "--border-floating-control",
    ],
    [
      "--affordance-subtle",
      "--affordance-subtle-hover",
      "--affordance-subtle-pressed",
      "--affordance-floating-control",
      "--affordance-floating-control-hover",
    ],
  ),
  ...on(
    // Only ink-strength icons and the chrome capsule sit directly on the shell.
    ["--text-standard", "--texture-dots-color", "--affordance-chrome"],
    ["--bg-app"],
  ),
  ...on(
    ["--text-standard", "--text-chrome-subtle"],
    ["--affordance-chrome", "--affordance-chrome-hover"],
  ),
  ...on(
    [
      "--text-standard",
      "--text-subtle",
      "--text-metadata",
      "--text-navigation",
      "--text-unavailable",
      "--border-standard",
      "--border-prominent",
      "--border-message-thread",
      "--scrollbar-thumb",
    ],
    [
      "--surface-base",
      "--surface-panel",
      "--surface-popover",
      "--surface-inset",
      "--surface-message",
    ],
  ),
  // Received bubbles keep neutral prose and the theme’s readable link ink.
  ...on(["--text-standard", "--text-message-link"], ["--surface-message"]),
  ...on(
    ["--text-message-own", "--text-message-link-own"],
    ["--surface-message-own"],
  ),
];
const grayOnAccent = [];
for (const family of accentFamilies)
  for (const level of [BASELINE_LEVEL, ...LEVELS])
    for (const [mode, map] of Object.entries(
      declarationsByMode(css, family, level),
    ))
      for (const [fgRole, groundRole] of GROUNDED) {
        const fg = resolve(map, fgRole);
        const ground = resolve(map, groundRole);
        if (fg && ground && isAccent(ground) && isGray(fg))
          grayOnAccent.push(
            `${family}/${level}/${mode}: ${fgRole} ${fg} is gray on ${groundRole} ${ground}`,
          );
      }
if (grayOnAccent.length)
  boundaryFailures.push(
    `Gray on an accent ground — move the role into the color group of its ground:\n    ${grayOnAccent.join("\n    ")}`,
  );

// Guard the maths itself: if these drift, every verdict above is wrong.
const REFERENCE = [
  ["#000000", "#ffffff", 106.04],
  ["#ffffff", "#000000", -107.88],
  ["#888888", "#ffffff", 63.06],
];
for (const [text, bg, expected] of REFERENCE) {
  const got = apcaContrast(text, bg);
  if (Math.abs(got - expected) > 0.05) {
    console.error(
      `✗ APCA implementation drifted: ${text} on ${bg} gave ${got.toFixed(2)}, expected ${expected}`,
    );
    process.exit(1);
  }
}

if (skipped.length > 0) {
  console.log(`ℹ ${skipped.length} pairing(s) not measurable as flat colour:`);
  for (const s of skipped) console.log(`    ${s}`);
}

for (const [pair, ratio] of acceptedAwayMeasurements) {
  console.log(
    `  (accepted Away contrast) ${pair}: ${ratio.toFixed(3)}:1 < 3:1 — approved unoutlined badge, not a contrast pass`,
  );
}
if (levelAwayMeasurements.size) {
  const faintest = Math.min(...levelAwayMeasurements.values());
  console.log(
    `  (Away at color levels) ${levelAwayMeasurements.size} pairs below 3:1 on accent surfaces, none fainter than the approved neutral floor (${faintest.toFixed(3)}:1 ≥ ${approvedAwayFloor.toFixed(3)}:1)`,
  );
}
const staleAwayPairs = [...ACCEPTED_AWAY_PAIRS].filter(
  (pair) => !acceptedAwayMeasurements.has(pair),
);
if (staleAwayPairs.length) {
  console.log("ℹ Accepted Away pairs no longer used — review and remove:");
  for (const pair of staleAwayPairs) console.log(`  ${pair}`);
}

if (boundaryFailures.length > 0) {
  console.error(
    `\n✗ Control/state boundaries:\n  ${boundaryFailures.join("\n  ")}`,
  );
}

if (failures.length > 0) {
  console.error(
    `\n✗ Contrast: ${failures.length} pairing(s) below their APCA or WCAG AA target\n`,
  );
  for (const f of failures) {
    console.error(
      `  ${f.mode.padEnd(5)} ${f.textRole} (${f.text}) on ${f.surfaceRole} (${f.surface})`,
    );
    console.error(
      `        Lc ${f.lc.toFixed(1)} — needs ${f.target}   [WCAG ${f.wcag.toFixed(2)}:1 — needs 4.5:1]`,
    );
  }
  console.error(
    "\nRaise the ramp step the role points at, or add a documented exception\nin scripts/check-contrast.mjs with a reason. See DESIGN.md § Contrast.\n",
  );
  process.exit(1);
}

if (boundaryFailures.length > 0) process.exit(1);
console.log(
  "✓ Contrast: checked text and control/state boundaries in both modes; accepted exceptions are listed explicitly",
);
for (const [role, why] of EXCEPTIONS) {
  console.log(`  (exception) ${role} — ${why.split(";")[0]}`);
}

const stale = [...EXCEPTIONS.keys()].filter(
  (key) => key.includes(" on ") && !claimedExceptions.has(key),
);
if (stale.length > 0) {
  console.log("\nℹ Pairing exceptions no longer needed — delete them:");
  for (const key of stale) console.log(`  ${key}`);
}
