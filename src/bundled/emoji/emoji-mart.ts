import { forwardTerminalKey as forwardHostKey } from "../../features/shortcuts/terminal-key-event";
import scrollbarStyles from "../../shared/design-system/styles/scrollbars.css?raw";
import searchFieldStyles from "../../shared/design-system/styles/search-field.css?raw";
import { pickerIcons } from "../../shared/design-system/icons/svg";
// Emoji Mart config adapted from block/buzz's shared picker; see NOTICE.md.
import data from "@emoji-mart/data";
import english from "@emoji-mart/data/i18n/en.json";
import { Data, Picker, SearchIndex } from "emoji-mart";
import type { CustomEmoji } from "../../features/relay/emoji";
import { rankShortcodes } from "./emoji-search";
import { PREVIEW_ACTION_SLOT } from "./add-emoji";
import {
  SKIN_TONE_SLOT,
  rememberSkinTone,
  savedSkinTone,
  skinToneUnchosen,
  toneHand,
} from "./skin-tone";
import { rootFontSize, spaciousGrid } from "./picker-layout";

const martSearch = SearchIndex.search;
const resolvedTheme = (value: unknown): "light" | "dark" =>
  value === "dark" ? "dark" : "light";

const prefix = "buzz-custom/";
// Idle and with no matches, the footer shows only its actions; the empty grid
// under the query already says nothing matched.
const previewStrings = {
  ...english,
  pick: "",
  search_no_results_1: "",
  search_no_results_2: "",
};
// Unknown IDs render nothing in place of Mart's pointing and crying emoji.
const NO_PREVIEW_EMOJI = "buzz-none";
/** Mart sets `title` only without a preview; identify results by their glyph. */
const resultKey = (button: HTMLButtonElement | undefined) =>
  button?.getAttribute("aria-label") ??
  button?.querySelector("img")?.getAttribute("alt") ??
  "";
// Mart's skin indexes in menu order: Default, then dark to light.
const TONE_ORDER = [1, 6, 5, 4, 3, 2];
const categoryIcons = {
  frequent: { svg: pickerIcons.clock },
  people: { svg: pickerIcons.smiley },
  nature: { svg: pickerIcons["paw-print"] },
  foods: { svg: pickerIcons.orange },
  activity: { svg: pickerIcons.barbell },
  places: { svg: pickerIcons.car },
  objects: { svg: pickerIcons.lightbulb },
  symbols: { svg: pickerIcons.shapes },
  flags: { svg: pickerIcons.flag },
  custom: { svg: pickerIcons.asterisk },
  "buzz-custom": { svg: pickerIcons.asterisk },
};
let active: (() => void) | undefined;
export type EmojiSearchSelection = {
  emoji: string | undefined;
  start: number | null;
  end: number | null;
  direction: "forward" | "backward" | "none" | null;
};

/** Mart owns a module-global dictionary/search index. Only one mounted picker
 * may use it; a React remount alone neither removes old emoji nor isolates scope. */
export function mountEmojiMart({
  host,
  colorMode,
  autoFocus = true,
  preview = false,
  scope,
  perLine,
  emojiSize,
  emojiButtonSize,
  search,
  searchSelection,
  searchChange,
  entries,
  media,
  select,
  close,
  skinToneChange,
}: {
  host: HTMLDivElement;
  colorMode?: "light" | "dark" | undefined;
  autoFocus?: boolean;
  /** Show the hovered or keyboard-selected emoji, its name and shortcode. */
  preview?: boolean;
  scope: string;
  perLine: number;
  emojiSize: number;
  emojiButtonSize: number;
  search: string;
  searchSelection: { current: EmojiSearchSelection | undefined };
  searchChange(value: string): void;
  entries: readonly CustomEmoji[];
  media(url: string): string | undefined;
  select(value: string, customEmoji?: string): void;
  close(): void;
  /** With `preview`, the footer's skin-tone action renders the saved tone (1–6). */
  skinToneChange?(tone: number, open: boolean): void;
}) {
  active?.();
  let disposed = false;
  const values = new Map<string, { literal: string; shortcode: string }>();
  const emojis = entries.flatMap(({ shortcode, url }) => {
    const src = media(url);
    if (!src) return [];
    const id = `${prefix}${encodeURIComponent(scope)}/${shortcode}`;
    const literal = `:${shortcode}:`;
    values.set(id, { literal, shortcode });
    // Match Mart's first-hyphen query normalization as well as individual words.
    const terms = [shortcode, literal].flatMap((name) => [
      name,
      ...name.replace(/(\w)-/, "$1 ").split(/[\s|,]+/),
      ...name.split(/[-_]+/),
    ]);
    return [
      {
        id,
        // The preview prints the name over the shortcode; avoid `:x:` twice.
        name: preview ? shortcode : literal,
        keywords: [shortcode],
        // Supplying search/shortcodes prevents Mart from exposing its scoped ID.
        search: `,${terms.join(",")}`,
        skins: [{ src, shortcodes: literal }],
      },
    ];
  });
  // Restore Mart's default Frequent row if storage contains a poisoned empty map.
  try {
    if (localStorage.getItem("emoji-mart.frequently") === "{}") {
      localStorage.removeItem("emoji-mart.frequently");
      localStorage.removeItem("emoji-mart.last");
    }
  } catch {
    /* Like Mart, selection works without localStorage. */
  }
  const picker = new Picker({
    data,
    custom: emojis.length
      ? [{ id: "buzz-custom", name: "Custom", emojis }]
      : [],
    autoFocus: false,
    categoryIcons,
    emojiButtonSize,
    emojiSize,
    dynamicWidth: false,
    maxFrequentRows: 2,
    // Ten category tabs overlap in narrow thread panes; search/scroll still work.
    navPosition: spaciousGrid(
      perLine * emojiButtonSize,
      rootFontSize(host.ownerDocument),
    )
      ? "bottom"
      : "none",
    perLine,
    ...(preview
      ? {
          previewPosition: "bottom",
          previewEmoji: NO_PREVIEW_EMOJI,
          noResultsEmoji: NO_PREVIEW_EMOJI,
          i18n: previewStrings,
        }
      : { previewPosition: "none" }),
    set: "native",
    // Mart prefers its saved tone; this covers a tone it could not save.
    skin: savedSkinTone() ?? 1,
    skinTonePosition: "search",
    // Widget mode follows the host, never the OS independently.
    theme: resolvedTheme(
      colorMode ?? host.ownerDocument.documentElement.dataset.colorMode,
    ),
    onEmojiSelect: (emoji: { native?: string; id?: string }) => {
      if (disposed) return;
      if (emoji.native) {
        if (!promptSkinTone(emoji.id)) select(emoji.native);
        return;
      }
      const custom = values.get(emoji.id ?? "");
      if (custom) select(custom.literal, custom.shortcode);
    },
  }) as unknown as HTMLElement;
  // The documented web-component attribute updates in place: do not recreate the
  // picker/dictionary (or lose search, focus and scroll) just to change appearance.
  const documentRoot = host.ownerDocument.documentElement;
  const syncAppearance = () => {
    picker.setAttribute(
      "theme",
      resolvedTheme(colorMode ?? documentRoot.dataset.colorMode),
    );
    picker.toggleAttribute(
      "data-keyboard-navigation",
      documentRoot.hasAttribute("data-keyboard-navigation"),
    );
  };
  syncAppearance();
  const themeObserver = new MutationObserver(syncAppearance);
  themeObserver.observe(documentRoot, {
    attributes: true,
    attributeFilter: ["data-color-mode", "data-keyboard-navigation"],
  });
  // Like the legacy picker, own search focus/corrections after async shadow render.
  const root = picker.shadowRoot;
  const navigationStyle = host.ownerDocument.createElement("style");
  navigationStyle.textContent = `
    :host {
      --font-family: var(--font-sans);
      --font-size: var(--text-body-sm);
      --category-icon-size: 1.125rem;
    }
    #root, input, button {
      color: var(--text-standard);
      font-family: var(--font-sans);
      font-size: var(--text-body-sm);
      line-height: var(--text-body-sm--line-height);
    }
    #root {
      --color-a: var(--text-standard);
      --color-b: var(--text-subtle);
      --color-c: var(--text-metadata);
      --em-color-border: var(--border-standard);
      --em-color-border-over: var(--affordance-subtle-hover);
      --buzz-category-fill: var(--affordance-subtle-hover);
      --buzz-category-icon: var(--text-subtle);
      --buzz-category-icon-selected: var(--text-standard);
      --buzz-category-label: var(--text-subtle);
      background: var(--surface-popover);
      color: var(--text-standard);
      font-family: var(--font-sans);
    }
    #root {
      ${preview ? "--buzz-preview-height: calc(var(--size-control) + 2 * var(--space-2)); --buzz-skin-menu-end: var(--picker-grid-gutter, var(--space-3));" : ""}
      --padding: var(--space-2);
      position: relative;
      width: 100% !important;
    }
    .scroll {
      padding-inline: var(--picker-grid-gutter, var(--space-3));
    }
    .scroll > div {
      width: 100% !important;
    }
    .category .sticky {
      background: var(--surface-popover);
      color: var(--buzz-category-label);
      font-size: var(--text-caption);
      font-weight: var(--type-weight-normal);
      letter-spacing: 0;
      line-height: var(--text-caption--line-height);
    }
    .search.search-field {
      width: calc(100% - 2 * var(--picker-search-margin, var(--space-1)));
      margin: var(--picker-search-top, var(--space-3)) var(--picker-search-margin, var(--space-1)) var(--space-3);
    }
    .search .icon {
      top: auto;
      right: auto;
      left: auto;
      transform: none;
    }
    .search .loupe {
      position: static;
      width: 1rem;
      height: 1rem;
      flex: 0 0 1rem;
      order: 0;
      color: var(--text-metadata);
      opacity: 1;
      pointer-events: none;
    }
    /* Emoji Mart fills every SVG; Tabler outline assets must stay unfilled. */
    svg.icons-tabler-outline {
      fill: none;
    }
    .search .icon svg {
      position: static;
      width: 1rem;
      height: 1rem;
      color: inherit;
    }

    /* The picker is a fixed-height column; without flex-shrink the footer
       collapses to its content, so idle and hovered states differ in height. */
    #preview {
      box-sizing: border-box;
      flex-shrink: 0;
      height: var(--buzz-preview-height);
      gap: var(--space-2);
      padding: var(--space-2) var(--picker-grid-gutter, var(--space-3));
      border-top: 1px solid var(--border-standard);
    }
    #preview::before {
      display: none;
    }
    #preview > .flex-grow {
      min-width: 0;
    }
    #preview > .flex-grow > .flex-auto {
      width: 2rem;
      height: 2rem !important;
    }
    #preview > .flex-grow > .flex-auto + div {
      margin-inline-start: var(--space-3);
    }
    /* Native glyphs match the 2rem custom image cap (the title type size). */
    /* A glyph keeps the inherited body line height (about 1.4x its size),
       which pushes it below center in the 2rem box. */
    #preview .emoji-mart-emoji,
    #preview .emoji-mart-emoji > span {
      display: block;
      line-height: 1;
    }
    /* Exactly the 2rem slot, so a wide glyph cannot crowd the name. */
    #preview .emoji-mart-emoji > span {
      width: 1em;
      font-size: var(--text-title) !important;
    }
    #preview .emoji-mart-emoji img {
      max-width: 2rem !important;
      max-height: 2rem !important;
    }
    #preview .preview-title {
      color: var(--text-standard);
      font-size: var(--text-body-sm);
      font-weight: var(--type-weight-medium);
      line-height: var(--text-body-sm--line-height);
    }
    #preview .preview-subtitle {
      color: var(--text-metadata);
      font-size: var(--text-caption);
      line-height: var(--text-caption--line-height);
    }
    #preview slot {
      flex-shrink: 0;
    }
    /* Slack's footer: Add emoji leads until an emoji is hovered or selected,
       then its preview takes that place; the skin tone stays at the end. */
    #preview slot[name="${PREVIEW_ACTION_SLOT}"]::slotted(*) {
      order: -1;
    }
    #preview[data-buzz-previewing] slot[name="${PREVIEW_ACTION_SLOT}"] {
      display: none;
    }

    .spacer {
      height: 0;
    }
    .spacer + .flex.flex-middle > .flex.flex-auto.flex-center.flex-middle {
      width: 0 !important;
      height: 0 !important;
      overflow: hidden;
      visibility: hidden;
    }
    .category .emoji-mart-emoji img {
      max-width: 2rem !important;
      max-height: 2rem !important;
    }
    /* Fixed columns keep short search rows aligned with Mart's padded category rows. */
    .scroll .category > :not(.sticky) > .flex {
      display: grid;
      grid-template-columns: repeat(${perLine}, ${emojiButtonSize}px);
      justify-content: space-between;
    }
    #nav button {
      position: relative;
      z-index: 1;
      color: var(--buzz-category-icon);
    }
    #nav {
      box-sizing: border-box;
      display: grid;
      width: 100%;
      height: var(--size-control);
      flex-shrink: 0;
      align-items: center;
      padding: 0 var(--padding);
    }
    #nav > .flex.relative > button {
      flex: 1 1 0;
    }
    #nav .buzz-skin-tone-nav-button {
      height: 1.125rem;
      flex: 1 1 0;
      border: 0;
    }

    #nav button::before {
      position: absolute;
      top: 50%;
      left: 50%;
      z-index: -1;
      width: 1.75rem;
      height: 1.75rem;
      border-radius: var(--radius-pill);
      background: transparent;
      content: "";
      pointer-events: none;
      transform: translate(-50%, -50%);
      transition: background-color 120ms ease;
    }
    #nav button[aria-selected] {
      color: var(--buzz-category-icon-selected);
    }
    #nav button[aria-selected]::before {
      background: var(--buzz-category-fill);
    }
    #nav .buzz-skin-tone-nav-button:hover::before,
    #nav .buzz-skin-tone-nav-button[aria-selected]::before {
      background: var(--buzz-category-fill);
    }
    #nav .buzz-skin-tone-nav-button .skin-tone {
      position: relative;
      z-index: 1;
    }
    .skin-tone {
      width: 1rem;
      height: 1rem;
    }
    .buzz-skin-tone-source {
      width: 0 !important;
      height: 0 !important;
      overflow: hidden;
      visibility: hidden;
    }
    #nav .bar {
      display: none;
    }
    #root > .menu {
      background: var(--surface-popover);
      border-color: var(--border-standard);
      border-radius: var(--radius-row);
      padding: var(--space-1);
      box-shadow: var(--shadow-sm);
      backdrop-filter: none;
      top: auto !important;
      /* Open above the footer's skin-tone action, or else the category bar. */
      right: var(--buzz-skin-menu-end, 0.5rem) !important;
      bottom: var(--buzz-preview-height, var(--size-control)) !important;
      left: auto !important;
      z-index: 100 !important;
      transform-origin: 100% 100%;
    }
    .menu .option {
      border-radius: var(--radius-chip);
      padding: var(--space-1) var(--space-1h);
    }
    .menu .option:hover {
      background: var(--affordance-subtle-hover);
      color: var(--text-standard);
    }
    /* Each tone shows as the footer's hand in that tone, not a colour dot. */
    .menu .skin-tone {
      width: auto;
      height: auto;
      overflow: visible;
      border-radius: 0;
      background: none;
      font-family: var(--font-emoji);
      font-size: var(--size-emoji-inline);
      line-height: 1;
    }
    .menu .skin-tone::after {
      display: none;
    }
    /* One row of hands, Default then dark to light; screen readers keep
       each radio's tone name. */
    #root > .menu {
      display: flex;
    }
${TONE_ORDER.map((tone, index) => `    #root > .menu > :nth-child(${tone}) { order: ${index}; }`).join("\n")}
    .menu .option {
      justify-content: center;
    }
    .menu .option > .margin-small-lr {
      display: none;
    }
${[1, 2, 3, 4, 5, 6].map((tone) => `    .menu .skin-tone-${tone}::before { content: var(--buzz-tone-${tone}, "${toneHand(tone)}"); }`).join("\n")}
    /* The saved tone is a fill; a ring marks keyboard focus only. */
    .menu input[type="radio"]:checked + .option {
      background: var(--affordance-selected);
      box-shadow: none;
    }
    :host([data-keyboard-navigation]) .menu input[type="radio"]:focus + .option {
      outline: 2px solid var(--border-focus);
      outline-offset: 2px;
    }
    @media (prefers-reduced-motion: reduce) {
      #nav button::before {
        transition-duration: 0ms;
      }
    }
  ${scrollbarStyles}
  ${searchFieldStyles}
  `;
  root?.appendChild(navigationStyle);
  let skinToneObserver: MutationObserver | undefined;
  /** Hide Mart's skin-tone button behind our own trigger, mirroring its state. */
  const proxySkinTone = (
    source: HTMLButtonElement,
    trigger: EventTarget,
    render: (tone: number, open: boolean) => void,
    focus: () => void,
  ) => {
    source.parentElement?.classList.add("buzz-skin-tone-source");
    let menuOpen = source.hasAttribute("aria-selected");
    const sync = () => {
      const open = source.hasAttribute("aria-selected");
      const dot = source.querySelector(".skin-tone")?.className ?? "";
      render(Number(/skin-tone-(\d)/.exec(dot)?.[1] ?? 1), open);
      if (menuOpen && !open) focus();
      menuOpen = open;
    };
    // An open menu closes through Mart's own click handling. Opening stops
    // here: Mart's document listener reads a slotted (light-DOM) trigger as
    // an outside click and would close the menu it just opened.
    trigger.addEventListener("click", (event) => {
      if (source.hasAttribute("aria-selected")) return;
      event.stopPropagation();
      source.click();
    });
    sync();
    skinToneObserver?.disconnect();
    skinToneObserver = new MutationObserver(sync);
    skinToneObserver.observe(source, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  };
  const placeSkinToneInNavigation = (source: HTMLButtonElement) => {
    const navigation = root?.querySelector<HTMLElement>(
      "#nav > .flex.relative",
    );
    const bar = navigation?.querySelector<HTMLElement>(":scope > .bar");
    if (!navigation || !bar) return;
    if (navigation.querySelector(".buzz-skin-tone-nav-button")) return;
    const button = host.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "buzz-skin-tone-nav-button flex flex-center flex-middle";
    button.setAttribute(
      "aria-label",
      source.getAttribute("aria-label") ?? "Choose skin tone",
    );
    button.title = source.title;
    const tone = host.ownerDocument.createElement("span");
    button.appendChild(tone);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    navigation.insertBefore(button, bar);
    proxySkinTone(
      source,
      button,
      (selected, open) => {
        button.toggleAttribute("aria-selected", open);
        tone.className = `skin-tone skin-tone-${selected}`;
      },
      () => button.focus(),
    );
  };
  /** The footer: Add emoji, Mart's preview, then the skin-tone action. */
  const placeFooter = (source: HTMLButtonElement) => {
    const row = root?.querySelector("#preview");
    if (!row) return;
    const slot = (name: string) => {
      const existing = row.querySelector<HTMLSlotElement>(
        `slot[name="${name}"]`,
      );
      if (existing) return { element: existing, created: false };
      const element = host.ownerDocument.createElement("slot");
      element.name = name;
      row.appendChild(element);
      return { element, created: true };
    };
    slot(PREVIEW_ACTION_SLOT);
    // Mark the hovered state from this render observer rather than relying on
    // `:has()` style invalidation inside Mart's shadow root.
    row.toggleAttribute(
      "data-buzz-previewing",
      !!row.querySelector(".emoji-mart-emoji"),
    );
    const tone = slot(SKIN_TONE_SLOT);
    if (!tone.created) return;
    proxySkinTone(
      source,
      tone.element,
      (selected, open) => skinToneChange?.(selected, open),
      () =>
        finishSkinTonePrompt() ||
        root
          ?.querySelector<HTMLSlotElement>(`slot[name="${SKIN_TONE_SLOT}"]`)
          ?.assignedElements()[0]
          ?.querySelector("button")
          ?.focus(),
    );
  };
  // Until a default tone is saved, the first pick of an emoji that has tones
  // opens the tone menu showing that emoji; the choice becomes the default.
  let promptedEmoji: string | undefined;
  let chosenTone: number | undefined;
  // Mart chooses a tone on an option click, or Enter, Space or Tab on its radio.
  const recordTone = (tone: number) => {
    chosenTone = tone;
    rememberSkinTone(tone);
  };
  root?.addEventListener(
    "click",
    (event) => {
      const option =
        event.target instanceof Element
          ? event.target.closest(".menu .option")
          : null;
      const radio = option?.previousElementSibling;
      if (radio instanceof HTMLInputElement) recordTone(Number(radio.value));
    },
    true,
  );
  root?.addEventListener(
    "keydown",
    (event) => {
      const radio = event.target;
      const { code } = event as KeyboardEvent;
      if (
        radio instanceof HTMLInputElement &&
        radio.matches('.menu input[type="radio"]') &&
        (code === "Enter" || code === "Space" || code === "Tab")
      )
        recordTone(Number(radio.value));
    },
    true,
  );
  const toneOptions = [1, 2, 3, 4, 5, 6].map((tone) => `--buzz-tone-${tone}`);
  const promptSkinTone = (id: string | undefined) => {
    if (!preview || !skinToneUnchosen()) return false;
    const skins = Data?.emojis[id ?? ""]?.skins;
    const source = root?.querySelector<HTMLButtonElement>(".skin-tone-button");
    const menuRoot = root?.querySelector<HTMLElement>("#root");
    if (!id || !source || !menuRoot || !(skins?.length > 1)) return false;
    for (const [index, name] of toneOptions.entries())
      menuRoot.style.setProperty(
        name,
        JSON.stringify(skins[index]?.native ?? skins[0].native),
      );
    promptedEmoji = id;
    chosenTone = undefined;
    source.click();
    return true;
  };
  /** Insert the prompted emoji in the chosen tone; dismissing inserts nothing. */
  const finishSkinTonePrompt = () => {
    const id = promptedEmoji;
    if (!id) return false;
    promptedEmoji = undefined;
    const menuRoot = root?.querySelector<HTMLElement>("#root");
    for (const name of toneOptions) menuRoot?.style.removeProperty(name);
    // The choice itself, not whether it saved, separates choosing from dismissing.
    const tone = chosenTone;
    const native = tone && Data?.emojis[id]?.skins[tone - 1]?.native;
    if (!native || disposed) return false;
    select(native);
    return true;
  };
  // Mart clears the preview whenever the pointer leaves an emoji, so crossing
  // the gaps between cells flashed the idle footer. Keep the last preview while
  // the pointer stays in the grid; leaving the grid clears it as before.
  let previewHeld = false;
  const insideGrid = (node: EventTarget | null) =>
    node instanceof Node && !!root?.querySelector(".scroll")?.contains(node);
  root?.addEventListener(
    "mouseleave",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.matches(".category button"))
        return;
      previewHeld = insideGrid((event as MouseEvent).relatedTarget);
      if (previewHeld) event.stopPropagation();
    },
    true,
  );
  // Mouseout bubbles from wherever the pointer was, even where an ancestor's
  // mouseleave is not reported, so it is the dependable signal for leaving.
  root?.addEventListener("mouseout", (event) => {
    if (!previewHeld || insideGrid((event as MouseEvent).relatedTarget)) return;
    previewHeld = false;
    // Any emoji's own leave handler clears Mart's preview.
    root
      ?.querySelector(".scroll .category button")
      ?.dispatchEvent(new MouseEvent("mouseleave"));
  });
  // Arrow keys follow the menu's visual order rather than Mart's DOM order.
  root?.addEventListener(
    "keydown",
    (event) => {
      const radio = event.target;
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[
        (event as KeyboardEvent).key
      ];
      if (!step || !(radio instanceof HTMLInputElement)) return;
      if (!radio.matches('.menu input[type="radio"]')) return;
      const position = TONE_ORDER.indexOf(Number(radio.value));
      const tone =
        TONE_ORDER[(position + step + TONE_ORDER.length) % TONE_ORDER.length];
      const next = radio
        .closest(".menu")
        ?.querySelector<HTMLInputElement>(`input[value="${tone}"]`);
      if (!next) return;
      event.preventDefault();
      next.checked = true;
      next.focus();
      next.dispatchEvent(new Event("change", { bubbles: true }));
    },
    true,
  );
  const placeSkinTone = () => {
    const source = root?.querySelector<HTMLButtonElement>(".skin-tone-button");
    if (!source) return;
    if (preview) placeFooter(source);
    else placeSkinToneInNavigation(source);
  };
  const installSearchIcon = (
    selector: string,
    name: "x" | "magnifying-glass",
  ) => {
    const icon = root?.querySelector<SVGSVGElement>(selector);
    if (!icon || icon.dataset.buzzSearchIcon) return;
    const template = document.createElement("template");
    template.innerHTML = pickerIcons[name];
    const replacement = template.content.firstElementChild;
    if (!replacement) return;
    // Preserve the widget-owned node so its renderer does not insert a second SVG.
    for (const attribute of [...icon.attributes])
      icon.removeAttribute(attribute.name);
    for (const attribute of [...replacement.attributes])
      icon.setAttribute(attribute.name, attribute.value);
    icon.innerHTML = replacement.innerHTML;
    icon.dataset.buzzSearchIcon = name;
    icon.setAttribute("aria-hidden", "true");
  };
  // A geometry remount must keep the chosen result, not just its query. Restore
  // through Mart's keyboard navigation, which also updates its internal grid.
  let pendingSelection = search ? searchSelection.current?.emoji : undefined;
  let restoringQuery = false;
  const visited = new Set<string>();
  const resultButtons = () => [
    ...(root?.querySelectorAll<HTMLButtonElement>(
      ".category:not([data-id]) button[aria-posinset]",
    ) ?? []),
  ];
  const selectedResult = () =>
    resultButtons().find(
      (button) => button.getAttribute("aria-selected") === "true",
    );
  const restoreSelection = (input: HTMLInputElement) => {
    if (!pendingSelection) return;
    const results = resultButtons();
    const selected = selectedResult();
    if (!selected) return; // Wait for the async search result render.
    if (
      resultKey(selected) === pendingSelection ||
      !results.some((button) => resultKey(button) === pendingSelection) ||
      visited.has(resultKey(selected))
    ) {
      pendingSelection = undefined;
      return;
    }
    visited.add(resultKey(selected));
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      }),
    );
    // The existing observer resumes after the selected-state DOM commit.
  };
  const focusSearch = () => {
    const input = root?.querySelector<HTMLInputElement>('input[type="search"]');
    if (!root || !input || disposed) return;
    placeSkinTone();
    root.querySelector(".scroll")?.classList.add("buzz-thin-scrollbar");
    input.parentElement?.classList.add("search-field");
    root
      .querySelector(".search .delete")
      ?.setAttribute("data-search-clear", "");
    installSearchIcon(".search .loupe svg", "magnifying-glass");
    installSearchIcon(".search .delete svg", "x");
    if (input.dataset.buzzSearchReady) {
      restoreSelection(input);
      return;
    }
    input.dataset.buzzSearchReady = "true";
    input.addEventListener("input", () => {
      if (!restoringQuery) {
        pendingSelection = undefined;
        searchSelection.current = undefined;
      }
      searchChange(input.value);
    });
    // Mart swallows every search key. Reuse the host's original-event handoff
    // (named for xterm) for keys the widget does not own; keep its navigation local.
    input.addEventListener(
      "keydown",
      (event) => {
        if (event.isTrusted && event.key.startsWith("Arrow"))
          pendingSelection = undefined;
        if (
          disposed ||
          [
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "Enter",
            "Escape",
          ].includes(event.key)
        )
          return;
        const hostWindow = host.ownerDocument.defaultView;
        if (hostWindow && !forwardHostKey(hostWindow, event))
          event.stopImmediatePropagation();
      },
      true,
    );
    input.spellcheck = false;
    input.placeholder = "Search emoji";
    input.setAttribute("aria-label", "Search emoji");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("autocapitalize", "off");
    if (search) {
      restoringQuery = true;
      input.value = search;
      const range = searchSelection.current;
      if (range?.start != null && range.end != null)
        input.setSelectionRange(
          range.start,
          range.end,
          range.direction ?? undefined,
        );
      input.dispatchEvent(new Event("input", { bubbles: true }));
      restoringQuery = false;
    }
    if (autoFocus) input.focus();
  };
  const observer = new MutationObserver(focusSearch);
  if (root)
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-selected"],
    });
  host.appendChild(picker);
  focusSearch();
  function dispose() {
    if (disposed) return;
    const input = root?.querySelector<HTMLInputElement>('input[type="search"]');
    if (input) searchChange(input.value);
    if (input)
      searchSelection.current = {
        emoji: pendingSelection ?? (resultKey(selectedResult()) || undefined),
        start: input.selectionStart,
        end: input.selectionEnd,
        direction: input.selectionDirection,
      };
    disposed = true;
    observer.disconnect();
    skinToneObserver?.disconnect();
    themeObserver.disconnect();
    // Keep focus inside the popup while its shadow search is replaced. Otherwise
    // Base UI's removal recovery can reclaim it after the new picker mounts.
    if (root?.activeElement) host.focus({ preventScroll: true });
    picker.remove(); // unregisters Mart's document listeners and observers
    for (const id of values.keys()) delete Data?.emojis[id];
    if (Data) {
      Data.categories = Data.categories.filter(
        (c: { id: string }) => c.id !== "buzz-custom",
      );
      Data.originalCategories = Data.originalCategories.filter(
        (c: { id: string }) => c.id !== "buzz-custom",
      );
    }
    SearchIndex.search = martSearch;
    SearchIndex.reset();
    if (active === dismiss) active = undefined;
  }
  function dismiss() {
    dispose();
    close();
  }
  active = dismiss;
  // Keep Mart's word-prefix results first, then fill its result limit with the
  // composer's fuzzy shortcode matches (`pointup`, `bufo_pray`, `bfpray`).
  SearchIndex.search = async (value, options) => {
    const results: { id: string }[] | null | undefined = await martSearch(
      value,
      options,
    );
    const limit = options?.maxResults || 90; // Mart's own default limit
    if (!results || results.length >= limit) return results;
    const found = new Set(results.map(({ id }) => id));
    const emojis: Record<string, { id: string; search?: string }> = Data.emojis;
    const candidates = [
      ...Object.values(emojis).map((emoji) => ({
        emoji,
        shortcode: values.get(emoji.id)?.shortcode ?? emoji.id,
      })),
      // Mart does not index alias shortcodes such as `open_book`.
      ...Object.entries<string>(Data.aliases).flatMap(([shortcode, id]) => {
        const emoji = emojis[id];
        return emoji ? [{ emoji, shortcode }] : [];
      }),
      // Mart leaves unsupported emoji in its dictionary without search terms.
    ].filter(({ emoji }) => emoji.search && !found.has(emoji.id));
    const fuzzy = rankShortcodes(
      String(value).replaceAll(":", ""),
      candidates,
      ({ shortcode }) => shortcode,
    );
    const extra = new Set(fuzzy.map(({ item }) => item.emoji));
    return [...results, ...extra].slice(0, limit);
  };
  // Search also caches results after deletion/replacement; recreate rather than update.
  SearchIndex.reset();
  return dispose;
}
