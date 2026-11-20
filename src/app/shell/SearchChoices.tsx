import { matchRank } from "../../features/search/match";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useEffect,
  useState,
  useId,
  useSyncExternalStore,
  type RefObject,
  type ReactNode,
} from "react";
import { Virtualizer } from "virtua";
import {
  ArrowRightIcon,
  type ChatCircleIcon,
  SparklesIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import type { PeekFollow, PeekTarget } from "./SearchPreview";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Badge } from "../../shared/design-system/ui/Badge";
import { Button } from "../../shared/design-system/ui/Button";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { matches, type KeyBinding } from "../../features/shortcuts/bindings";
import {
  formatBinding,
  isApplePlatform,
} from "../../features/shortcuts/format";
import { MatchedLabel } from "../../features/search/MatchedLabel";
import { useSearchHighlight } from "../../features/search/use-search-highlight";
import { channelIconClass } from "../../shared/inline-reference";
import { PageIcon } from "./PageIcon";
import "./SearchChoices.css";

/** Narrow windows have no room for the preview; SearchChoices.css stacks the
 * workspace at the same width. */
const NARROW = "(max-width: 760px)";
const watchNarrow = (change: () => void) => {
  const query = globalThis.matchMedia?.(NARROW);
  query?.addEventListener("change", change);
  return () => query?.removeEventListener("change", change);
};
const isNarrow = () => !!globalThis.matchMedia?.(NARROW).matches;

export type SearchDestination = {
  content?: ReactNode;
  rank?: number;
  key: string;
  label: string;
  /** Shown in place of `label` where text alone cannot show it, as a
   * message's mention chips; `matches` still index `label`. */
  labelContent?: ReactNode;
  detail?: string;
  /** Quiet metadata at the row's end, such as a count. */
  trailing?: ReactNode;
  /** Leads `detail`, as a channel mention's icon leads its name in a
   * message. */
  detailIcon?: typeof ChatCircleIcon | undefined;
  /** What `detailIcon` shows, read before `detail` but neither shown nor
   * matched. */
  detailIconLabel?: string | undefined;
  /** Code points of `label` that match the typed text. */
  matches?: readonly number[];
  icon: typeof ChatCircleIcon;
  image?: string | undefined;
  avatar?:
    | {
        src?: string | undefined;
        shape: "circle" | "squircle";
        /** Whose initials stand in for a missing image; the label's if not given. */
        name?: string | undefined;
      }
    | undefined;
  /** What the preview beside the results reads for this row. */
  peek?: PeekTarget | undefined;
  /** The row's own kind, where its group mixes kinds. */
  kind?: SearchTone | undefined;
  /** What choosing the row does, said in a preview that has nothing else to
   * show, e.g. "Open Activity". */
  action?: string | undefined;
  /** Stays with the row above it: a group cut short in Top results keeps
   * the two together, one row past its usual limit if need be. A cut that
   * hides the row above still shows this one, after the rows shown. */
  attached?: boolean | undefined;
  run: () => void;
};

export type SearchGroup = {
  label: string;
  /** Name the group for assistive technology only, when the view's own tab
   * already says what it holds. */
  hideLabel?: boolean;
  /** Message-content scores are not comparable to named destinations. */
  rank?: number;
  destinations: readonly SearchDestination[];
  /** How many rows the whole list holds when only its first are drawn, so
   * assistive technology counts them all. */
  total?: number;
  empty?: ReactNode;
  notice?: ReactNode;
  /** Non-interactive visual status; callers own its live announcement. */
  headingStatus?: string | undefined;
  /** Why the group sits where it does, e.g. "Exact name". */
  why?: string | undefined;
  /** Its rows are in the order a decision provider judged best, which a
   * small mark after the heading shows. */
  reranked?: boolean | undefined;
  /** How many it holds when that differs from its rows, e.g. "20+". */
  count?: string | undefined;
  /** The group's icon in the rail. */
  icon?: typeof ChatCircleIcon | undefined;
  /** The hue Peek tints the group's icons with. */
  tone?: SearchTone | undefined;
  /** Rows show their whole detail, wrapped, rather than one line of it. */
  multiline?: boolean | undefined;
  /** Peek lists it beside Top results and shows it whole when chosen, but
   * not among them. */
  browse?: boolean | undefined;
};

/** What kind of thing a group holds, for Peek's icon tints. */
export type SearchTone =
  | "channel"
  | "person"
  | "chat"
  | "agent"
  | "plugin"
  | "page"
  | "message";

/** Results beside a preview of the highlighted row, with a rail of the
 * groups they fall in. Ranked, the Top results view shows a few rows of each
 * group, and Tab shows one group whole. */
export type SearchPeek = {
  /** Every kind of result ranked together, with group filters above. */
  ranked: boolean;
  /** The panel beside the results, ranked or not; left out where the
   * results show no preview. `tone` is the row's own hue, else that of the
   * group it is in. `follow` is set while nobody has moved the highlight, so
   * it follows the first row, which more typing or results still arriving
   * may replace. */
  preview?:
    | ((
        row: SearchDestination | undefined,
        tone: SearchTone | undefined,
        follow: PeekFollow | undefined,
      ) => ReactNode)
    | undefined;
  /** Shown under the field, such as filters to add. */
  hints?: ReactNode;
  /** Results that may still arrive, so the list is busy. */
  busy?: boolean;
  /** Groups whose source hasn't searched this text as typed (a last word
   * too short to search messages, say), so they may still come back, each
   * with the reason shown while it's chosen. */
  unsearched?: Readonly<Record<string, ReactNode>> | undefined;
  /** Called once the person moves the highlight for this text: rows on
   * screen shouldn't move under them after that. */
  onMove?: (() => void) | undefined;
};

/** The person's keys for the previous and next result, which the field
 * matches and the key hints show. */
export type SearchSteps = { previous: KeyBinding; next: KeyBinding };
export const DEFAULT_SEARCH_STEPS: SearchSteps = {
  previous: { key: "ArrowUp" },
  next: { key: "ArrowDown" },
};
export const SearchStepsContext = createContext(DEFAULT_SEARCH_STEPS);
/** Vim's and Emacs's keys, with Control itself on every platform: a step to
 * the next or previous result, or to the next or previous group as Tab. */
const CONTROL_STEPS = new Map<string, readonly ["result" | "group", boolean]>([
  ["j", ["result", true]],
  ["n", ["result", true]],
  ["k", ["result", false]],
  ["p", ["result", false]],
  ["l", ["group", true]],
  ["f", ["group", true]],
  ["h", ["group", false]],
  ["b", ["group", false]],
]);

/** Top results shows this many rows of its first group, and of the rest. */
const LEAD_ROWS = 5;
const GROUP_ROWS = 3;
/** One group shown whole draws only the rows near the view past this many,
 * so moving through every joined conversation stays quick. */
const VIRTUAL_ROWS = 50;

/** A chosen filter shown before the typed text. */
export type SearchChip = {
  /** As the query holds it, e.g. `from:<key>` or `in:<channel id>`. */
  operand: string;
  /** What the chip shows, e.g. `from:@Wes`. */
  text: string;
  /** The text Backspace restores for editing. */
  edit: string;
  /** The remove button's accessible name. */
  label: string;
  title?: string;
};

export type SearchInputProps = {
  inlineSettings?: readonly SearchGroup[] | undefined;
  query: string;
  onQueryChange: (query: string) => void;
  input: RefObject<HTMLElement | null>;
  label?: string;
  /** One conversation the search is narrowed to, by `id`. */
  scope?: { id: string; label: string; onRemove: () => void } | undefined;
  /** A control that refines the results, inside the field after Clear. */
  fieldAction?: ReactNode;
  chips?: readonly SearchChip[] | undefined;
  onRemoveChip?: ((chip: SearchChip) => void) | undefined;
  /** Backspace before the text edits the last chip. */
  onEditLastChip?: (() => void) | undefined;
  displayQuery?: string | undefined;
  onDisplayQueryChange?: ((value: string) => void) | undefined;
  /** False while the palette closes, so a held Enter chooses nothing. */
  open?: boolean | undefined;
};

/** How the results list is named and where it was left. */
export type SearchViews = {
  /** Names the results list. */
  resultsLabel: string;
  /** Where the results were: their scroll position and highlighted row,
   * restored as the view mounts and kept as they change. */
  place: SearchPlace;
};

/** A kept place in the results. `anchor` is the first row in view and how
 * far above the view's top it sat, so a list whose order changed while
 * closed reopens on the same rows rather than the same pixels. */
export type SearchPlace = {
  top: number;
  key: string;
  anchor?: { key: string; offset: number } | undefined;
};

const rowKeysOf = (elements: readonly Element[]) =>
  elements.flatMap((row) =>
    row instanceof HTMLElement && row.dataset.searchKey
      ? [row.dataset.searchKey]
      : [],
  );

export function SearchChoices({
  groups: originalGroups,
  query,
  onQueryChange,
  chips,
  onRemoveChip,
  onEditLastChip,
  displayQuery,
  onDisplayQueryChange,
  input,
  label = "Search Buzz",
  scope,
  fieldAction,
  children,
  footer,
  inlineSettings,
  open = true,
  pending = false,
  isAction,
  views,
  highlightEmpty = false,
  onRowsShown,
  peek,
  completing = false,
  completionPending = false,
  conversationShortcut,
  onBack,
}: SearchInputProps & {
  groups: readonly SearchGroup[];
  children?: ReactNode;
  /** Kept below the results, outside their scrollport, so it stays in view
   * however long the list: a limit on what is searched and its recovery. */
  footer?: ReactNode;
  /** A row that should lead may still arrive, so Enter before any row
   * waits until it has. */
  pending?: boolean;
  /** Whether a row acts on the search rather than being a result, so Enter
   * on it can wait for `pending` like Enter before any row. */
  isAction?: (key: string) => boolean;
  views?: SearchViews | undefined;
  /** Highlight the first row before anything is typed, for a view whose
   * unfiltered list is the list to choose from. */
  highlightEmpty?: boolean;
  /** Hears the keys of rows scrolled into (or near) view, for details worth
   * reading only for the rows someone can see. */
  onRowsShown?: ((keys: readonly string[]) => void) | undefined;
  peek?: SearchPeek | undefined;
  /** The rows complete an unfinished filter, such as `in:` or `from:`, so
   * Tab chooses the highlighted one as Enter does. */
  completing?: boolean;
  /** The suggestions that would complete the filter are still loading, so
   * Tab stays in the field rather than leaving before they arrive. */
  completionPending?: boolean;
  /** Hinted with the keys below: the chord that searches the current
   * conversation instead. */
  conversationShortcut?: KeyBinding | undefined;
  /** Set while the caller shows a view over the results, such as a guide:
   * Escape in the palette leaves it rather than search. */
  onBack?: (() => void) | undefined;
}) {
  const palette = useRef<HTMLDivElement>(null);
  // A hidden preview would still read; it mounts only where it shows.
  const narrow = useSyncExternalStore(watchNarrow, isNarrow);
  const preview = peek?.preview;
  const previewing = !!preview;
  const peekPanelPrefix = useId();
  const peekPanelId = (label: string | undefined) =>
    `${peekPanelPrefix}-group-${encodeURIComponent(label ?? "")}`;
  const resultsViewport = useRef<HTMLDivElement>(null);
  const resultsContent = useRef<HTMLDivElement>(null);
  // Peek fills its dialog; only a palette sized by its results eases height.
  const fills = !!peek;
  useLayoutEffect(() => {
    const viewport = resultsViewport.current;
    const content = resultsContent.current;
    if (!viewport || !content || fills) return;
    let initialized = false;
    let frame = 0;
    const measure = () => {
      const height = content.offsetHeight;
      viewport.style.height = `${height}px`;
      if (!initialized) {
        initialized = true;
        frame = requestAnimationFrame(() => {
          viewport.dataset.measured = "";
        });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [fills]);
  const needle = query.trim().toLowerCase();
  const score = (group: SearchGroup) =>
    group.rank ??
    Math.min(
      matchRank(group.label, needle) ?? Infinity,
      ...group.destinations.map(
        (row) =>
          row.rank ??
          Math.min(
            matchRank(row.label, needle) ?? Infinity,
            matchRank(row.detail ?? "", needle) ?? Infinity,
          ),
      ),
    );
  // Upstream order includes usage and remembered choices. Only insert the new
  // groups; never re-rank existing destinations from their display labels.
  const merged = [...originalGroups];
  for (const group of [...(inlineSettings ?? [])].sort(
    (a, b) => score(a) - score(b),
  )) {
    const index = merged.findIndex(
      (existing) => score(existing) > score(group),
    );
    merged.splice(index < 0 ? merged.length : index, 0, group);
  }
  // Peek: Top results, or one group whole.
  const [peekScope, setPeekScope] = useState<string>();
  // Once the person moves, the groups shown keep their places for this text,
  // and groups that arrive later go after them.
  const frozen = useRef<{ query: string; labels: string[] }>(undefined);
  if (frozen.current && frozen.current.query !== query)
    frozen.current = undefined;
  const order = peek?.ranked ? frozen.current?.labels : undefined;
  if (order) {
    const place = (group: SearchGroup) => {
      const index = order.indexOf(group.label);
      return index < 0 ? order.length : index;
    };
    merged.sort((a, b) => place(a) - place(b));
  }
  const resultRows = (group: SearchGroup) =>
    group.destinations.filter((row) => !isAction?.(row.key));
  const ranked = peek?.ranked
    ? merged.filter((group) => resultRows(group).length)
    : [];
  // A chosen group stays chosen while an edited query's results land, or
  // while its source hasn't searched the text as typed, shown by its own
  // status until it has rows. It's let go once its source has searched and
  // settled without it. Shown or not, the choice is never kept out of sight.
  // With nothing typed, the first group is the view search opens on, so
  // there is no Top results above it.
  const home = needle ? undefined : ranked[0]?.label;
  const chosen = ranked.find((group) => group.label === (peekScope ?? home));
  const awaited =
    !!peekScope &&
    (!!peek?.busy || Object.hasOwn(peek?.unsearched ?? {}, peekScope));
  // Peek turned off (a filter such as `in:` added) lets it go too.
  if (peekScope && (!peek?.ranked || (!chosen && !awaited)))
    setPeekScope(undefined);
  const held =
    peek?.ranked && peekScope && !chosen && awaited
      ? (merged.find((group) => group.label === peekScope) ?? {
          label: peekScope,
          destinations: [],
        })
      : undefined;
  const landing = held && {
    ...held,
    empty: held.empty ?? peek?.unsearched?.[held.label],
  };
  const scoped = chosen ?? landing;
  const tabs = landing ? [...ranked, landing] : ranked;
  const countOf = (group: SearchGroup) =>
    group.count ?? String(resultRows(group).length);
  /** How many rows Top results shows of each group it cuts short. */
  const truncated = new Map<string, number>();
  const groups: SearchGroup[] = !peek?.ranked
    ? merged
    : scoped
      ? [scoped]
      : merged
          .filter((group) => !group.browse)
          .map((group) => {
            const place = ranked.indexOf(group);
            if (place < 0) return group;
            const rows = resultRows(group);
            const cap = place === 0 ? LEAD_ROWS : GROUP_ROWS;
            const limit = rows[cap]?.attached ? cap + 1 : cap;
            if (rows.length <= limit && !group.count)
              return { ...group, destinations: rows };
            const shown = [
              ...rows.slice(0, limit),
              ...rows.slice(limit).filter((row) => row.attached),
            ];
            truncated.set(group.label, shown.length);
            // Each row is read as one of the whole group: "1 of 37", or of
            // an open set when more may follow ("20+").
            const count = countOf(group);
            return {
              ...group,
              destinations: shown,
              total: /^\d+$/.test(count) ? Number(count) : -1,
            };
          });
  const showScope = (label: string | undefined, focusInput = true) => {
    setPeekScope(label);
    const first = (
      label ? ranked.find((group) => group.label === label) : ranked[0]
    )?.destinations[0]?.key;
    if (first) highlight.select(first);
    if (resultsContent.current) resultsContent.current.scrollTop = 0;
    if (focusInput) input.current?.focus();
  };
  /** Shows the group after or before the one shown, Top results (or an empty
   * search's first group) first; false past either end. */
  const stepScope = (forward: boolean) => {
    const order = [
      ...(home ? [] : [undefined]),
      ...tabs.map(({ label }) => label),
    ];
    const next = order.indexOf(scoped?.label) + (forward ? 1 : -1);
    if (next < 0 || next >= order.length) return false;
    showScope(order[next]);
    return true;
  };
  const hasControls = groups.some((group) =>
    group.destinations.some((row) => row.content),
  );
  const destinations = groups.flatMap((group) => group.destinations);
  const apple = isApplePlatform(navigator.platform);
  const shortcutNumbers = new Map(
    destinations.slice(0, 9).map(({ key }, index) => [key, index + 1]),
  );
  const place = views?.place;
  const keys = destinations.map(({ key }) => key);
  const highlight = useSearchHighlight({
    // A view over the results has a highlight of its own, so an Enter
    // waiting for results never runs one of its rows.
    query: onBack ? `\u0000${query}` : query,
    keys,
    onChoose: (key) => {
      // Choosing acts on the order shown: a later rerank must not move it.
      peek?.onMove?.();
      destinations.find((row) => row.key === key)?.run();
    },
    open,
    pending,
    isAction,
    highlightEmpty,
    followFirst: !!peek?.ranked,
    within: scope?.id,
    // A kept place keeps its row: Enter never chooses a row scrolled away.
    ...(place?.key && keys.includes(place.key)
      ? { initial: place.key }
      : place?.top
        ? { initial: "" }
        : {}),
  });
  const selected = highlight.active;
  const onMove = peek?.onMove;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reports each text's first move once.
  useEffect(() => {
    if (highlight.moved) onMove?.();
  }, [highlight.moved, query]);
  const moved = previewing && highlight.moved;
  const steps = useContext(SearchStepsContext);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Freezes the order just shown, once per text.
  useLayoutEffect(() => {
    if (!moved || frozen.current) return;
    // Only groups on screen keep a place; one still empty arrives later.
    frozen.current = {
      query,
      labels: merged
        .filter((group) => group.destinations.length)
        .map(({ label }) => label),
    };
  }, [moved, query]);
  // A highlight is kept only while its row is in view: one scrolled away
  // would reopen with Enter choosing a row nobody can see.
  useEffect(() => {
    if (place) place.key = selected;
  }, [place, selected]);
  const rowBox = (key: string) =>
    document.getElementById(highlight.rowId(key))?.getBoundingClientRect();
  const inView = (key: string) => {
    const content = resultsContent.current;
    const row = key ? document.getElementById(highlight.rowId(key)) : null;
    if (!content || !row) return false;
    const box = row.getBoundingClientRect();
    const view = content.getBoundingClientRect();
    // A cut group's pinned heading covers the rows scrolling under it.
    const heading = row
      .closest(".search-palette-group")
      ?.querySelector("[data-search-cut]")
      ?.getBoundingClientRect();
    const top = Math.max(view.top, heading?.bottom ?? view.top);
    return box.bottom > top && box.top < view.bottom;
  };
  const keepPlace = () => {
    const content = resultsContent.current;
    if (!place || !content) return;
    place.key = inView(selected) ? selected : "";
    // Rows stack in order: find the first one reaching into the view.
    const top = content.getBoundingClientRect().top;
    let low = 0;
    let high = keys.length - 1;
    let anchor: SearchPlace["anchor"];
    while (low <= high) {
      const middle = (low + high) >> 1;
      const key = keys[middle];
      const box = key ? rowBox(key) : undefined;
      if (!key || !box) break;
      if (box.bottom > top) {
        anchor = { key, offset: top - box.top };
        high = middle - 1;
      } else low = middle + 1;
    }
    place.anchor = anchor;
  };
  useEffect(() => {
    input.current?.focus();
  }, [input]);
  const resultsLabel = views?.resultsLabel ?? "Search results";
  // A group drawn in part says where each row sits in the whole of it.
  const positions = new Map<
    string,
    { "aria-setsize": number; "aria-posinset": number }
  >();
  // Peek's one group shown whole, when long, draws only the rows near the
  // view: each says where it sits, and the highlighted one stays drawn.
  const virtual = !!scoped && scoped.destinations.length > VIRTUAL_ROWS;
  const highlighted = virtual
    ? destinations.findIndex(({ key }) => key === selected)
    : -1;
  const keepMounted = highlighted < 0 ? [] : [highlighted];
  for (const { destinations, total } of groups) {
    const size = total ?? (virtual ? destinations.length : undefined);
    if (size !== undefined)
      for (const [index, { key }] of destinations.entries())
        positions.set(key, {
          "aria-setsize": size,
          "aria-posinset": index + 1,
        });
  }
  // A view returns to its kept position, waiting for late rows to make room
  // until the person scrolls or moves the highlight themselves.
  const restore = useRef(place?.top ?? 0);
  const restoreScroll = () => {
    const content = resultsContent.current;
    if (!content || !restore.current) return;
    const anchor = place?.anchor;
    const box = anchor && rowBox(anchor.key);
    const target =
      anchor && box
        ? content.scrollTop +
          box.top -
          content.getBoundingClientRect().top +
          anchor.offset
        : restore.current;
    content.scrollTop = target;
    if (Math.abs(content.scrollTop - target) <= 1) restore.current = 0;
  };
  /** Once the kept place is back, a highlight left out of view is dropped,
   * so Enter never chooses a row nobody can see. */
  const settling = useRef(!!place?.top);
  const settle = () => {
    if (!settling.current || restore.current) return;
    settling.current = false;
    if (selected && !inView(selected)) highlight.clear();
  };
  // Before paint, and again after the highlight reveals its first row.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Rows arriving give the kept position room.
  useLayoutEffect(() => {
    const target = restore.current;
    restoreScroll();
    restore.current = target;
  }, [destinations.length]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Rows arriving give the kept position room.
  useEffect(() => {
    restoreScroll();
    settle();
  }, [destinations.length]);
  const shown = useRef(onRowsShown);
  shown.current = onRowsShown;
  const watching = !!onRowsShown;
  const rowsObserver = useRef<
    { observer: IntersectionObserver; watched: Set<Element> } | undefined
  >(undefined);
  useEffect(() => {
    const root = resultsContent.current;
    if (!root || !watching || typeof IntersectionObserver === "undefined")
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = rowKeysOf(
          entries.flatMap((entry) =>
            entry.isIntersecting ? [entry.target] : [],
          ),
        );
        if (visible.length) shown.current?.(visible);
      },
      // Half a view ahead, so details are usually there before the row is.
      { root, rootMargin: "50% 0px" },
    );
    rowsObserver.current = { observer, watched: new Set() };
    return () => {
      observer.disconnect();
      rowsObserver.current = undefined;
    };
  }, [watching]);
  const rowKeys = destinations.map(({ key }) => key).join("\n");
  // Only rows not yet watched start watching, so a list that grows as it
  // scrolls doesn't observe its earlier rows again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: New rows need watching.
  useEffect(() => {
    const root = resultsContent.current;
    if (!root || !watching) return;
    const rows = [...root.querySelectorAll<HTMLElement>("[data-search-key]")];
    const watch = rowsObserver.current;
    if (!watch) {
      shown.current?.(rowKeysOf(rows));
      return;
    }
    for (const row of watch.watched)
      if (!row.isConnected) {
        watch.observer.unobserve(row);
        watch.watched.delete(row);
      }
    for (const row of rows)
      if (!watch.watched.has(row)) {
        watch.watched.add(row);
        watch.observer.observe(row);
      }
  }, [watching, rowKeys]);
  /** One row: a row with its own controls, or a destination. */
  const renderRow = (
    {
      content,
      key,
      label,
      labelContent,
      detail,
      detailIcon: DetailIcon,
      detailIconLabel,
      trailing,
      matches,
      icon,
      image,
      avatar,
      kind,
    }: SearchDestination,
    multiline: boolean | undefined,
  ) =>
    content ? (
      // biome-ignore lint/a11y/useSemanticElements: Interactive search grid, not a data table.
      <div
        key={key}
        {...highlight.rowProps(key)}
        role="row"
        aria-label={[label, detail].filter(Boolean).join(" — ")}
        aria-selected={selected === key}
        tabIndex={-1}
        className="search-control-row"
        data-highlighted={selected === key || undefined}
        onClick={(event) => {
          if (!event.currentTarget.contains(event.target as Node)) return;
          if (
            (event.target as HTMLElement).closest(
              "button, input, label, [role=switch], [role=combobox]",
            )
          )
            return;
          highlight.choose(key);
        }}
        onKeyDownCapture={(event) => {
          const target = event.target as HTMLElement;
          if (
            target !== event.currentTarget &&
            event.currentTarget.contains(target) &&
            !target.closest('[role="combobox"][aria-expanded="true"]')
          )
            highlight.rowProps(key).onKeyDown(event);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            highlight.choose(key);
          } else highlight.rowProps(key).onKeyDown(event);
        }}
      >
        {/* biome-ignore lint/a11y/useSemanticElements: Interactive search grid, not a data table. */}
        <div id={key} role="gridcell" tabIndex={-1}>
          {content}
        </div>
      </div>
    ) : (
      // biome-ignore lint/a11y/useAriaPropsSupportedByRole: Selection and label apply only to the grid row.
      // biome-ignore lint/a11y/noStaticElementInteractions: Keyboard handling applies only to the grid row.
      <div
        key={key}
        {...(hasControls ? highlight.rowProps(key) : {})}
        role={hasControls ? "row" : "presentation"}
        aria-label={
          hasControls
            ? [
                label,
                detail && detailIconLabel
                  ? `${detailIconLabel}, ${detail}`
                  : detail,
              ]
                .filter(Boolean)
                .join(" — ")
            : undefined
        }
        aria-selected={hasControls ? selected === key : undefined}
        tabIndex={hasControls ? -1 : undefined}
        data-search-result={hasControls ? "" : undefined}
        data-search-key={watching ? key : undefined}
        data-highlighted={(hasControls && selected === key) || undefined}
        onKeyDown={
          hasControls
            ? (event) => {
                if (
                  event.target === event.currentTarget &&
                  event.key === "Enter"
                ) {
                  event.preventDefault();
                  highlight.choose(key);
                } else highlight.rowProps(key).onKeyDown(event);
              }
            : undefined
        }
      >
        <div role={hasControls ? "gridcell" : "presentation"}>
          <NavigationItem
            variant="search"
            key={key}
            {...(!hasControls ? highlight.rowProps(key) : {})}
            role={hasControls ? "button" : "option"}
            aria-selected={hasControls ? undefined : selected === key}
            {...(!hasControls && positions.get(key))}
            tabIndex={-1}
            aria-current={false}
            multiline={!!multiline}
            highlighted={selected === key}
            data-search-result={!hasControls ? "" : undefined}
            aria-keyshortcuts={
              shortcutNumbers.has(key)
                ? `Shift+${apple ? "Meta" : "Control"}+${shortcutNumbers.get(key)}`
                : undefined
            }
            icon={
              <span
                className="search-row-icon grid size-6 shrink-0 place-items-center"
                data-tile={(!avatar && !image) || undefined}
                data-tone={kind}
              >
                {avatar ? (
                  <Avatar
                    alt=""
                    fallback={avatar.name ?? label}
                    src={avatar.src}
                    size="small"
                    shape={avatar.shape}
                  />
                ) : (
                  <PageIcon
                    icon={icon}
                    image={image}
                    size={peek && !image ? 15 : 21}
                  />
                )}
              </span>
            }
            label={
              <>
                <span className="block truncate text-body-sm">
                  {labelContent ?? (
                    <MatchedLabel label={label} positions={matches} />
                  )}
                </span>
                {detail && (
                  <span
                    className={`block text-body-sm text-subtle ${multiline ? "whitespace-pre-wrap" : "truncate"}`}
                  >
                    {/* Read in place of the icon. jsdom (dom-accessibility-api) trims
                      each element's text, so the space sits outside the span;
                      browsers don't trim it. Shown, the space collapses at the
                      line's start. */}
                    {detailIconLabel && (
                      <>
                        <span className="sr-only">{`${detailIconLabel},`}</span>{" "}
                      </>
                    )}
                    {/* Text-sized and spaced as LinkLabel shows a channel mention's icon. */}
                    {DetailIcon && (
                      <DetailIcon className={channelIconClass(DetailIcon)} />
                    )}
                    {detail}
                  </span>
                )}
              </>
            }
            trailing={trailing}
            onClick={() => highlight.choose(key)}
          />
        </div>
      </div>
    );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Hears Escape from the controls inside; the palette takes no input of its own.
    <div
      ref={palette}
      className="search-palette"
      data-search-palette=""
      data-search-footer={footer ? "" : undefined}
      data-search-peek={peek ? "" : undefined}
      {...highlight.listProps}
      // Escape from anywhere in the palette, the field or a control beside
      // it, leaves the caller's view first. A menu it opened closes alone.
      onKeyDown={(event) => {
        if (
          event.key !== "Escape" ||
          !onBack ||
          !palette.current?.contains(event.target as Node)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        onBack();
        input.current?.focus();
      }}
    >
      {scope && (
        <div className="search-palette-scope-row">
          <button
            type="button"
            className="search-palette-scope"
            aria-label={`Remove ${scope.label} search scope`}
            onClick={scope.onRemove}
          >
            {scope.label} <span aria-hidden="true">×</span>
          </button>
        </div>
      )}
      <div className="search-palette-controls">
        <SearchField
          variant="palette"
          prefix={
            chips?.length ? (
              <span className="search-palette-author-prefix">
                {chips.map((chip) => (
                  // A chosen filter, led by its guide row's dot; one click
                  // removes it, as Backspace before the text edits it.
                  <Button
                    key={chip.operand}
                    variant="subtle"
                    size="sm"
                    data-search-filter-chip=""
                    data-operator={chip.operand
                      .slice(0, chip.operand.indexOf(":"))
                      .toLowerCase()}
                    aria-label={chip.label}
                    title={chip.title}
                    // The field keeps focus, so typing carries on.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onRemoveChip?.(chip)}
                  >
                    <span className="search-filter-dot" aria-hidden="true" />
                    <span className="search-filter-chip-text">{chip.text}</span>
                    <XIcon size={16} aria-hidden="true" />
                  </Button>
                ))}
              </span>
            ) : undefined
          }
          trailing={fieldAction}
          inputRef={input}
          role="combobox"
          aria-controls={highlight.listId}
          aria-expanded="true"
          aria-autocomplete="list"
          aria-haspopup={hasControls ? "grid" : "listbox"}
          {...highlight.fieldProps}
          label={label}
          placeholder="Search"
          value={displayQuery ?? query}
          onValueChange={onDisplayQueryChange ?? onQueryChange}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          maxLength={256}
          onKeyDown={(event) => {
            const native = event.nativeEvent;
            // The person's result keys come first, so no other key in the
            // field takes a chord Settings accepted for them. Bare Up and
            // Down always move too, as a combobox's arrows do. As in the
            // dispatcher, composition and AltGr never match.
            if (!native.isComposing && native.keyCode !== 229) {
              const step = (
                [
                  [steps.next, true],
                  [steps.previous, false],
                  [DEFAULT_SEARCH_STEPS.next, true],
                  [DEFAULT_SEARCH_STEPS.previous, false],
                ] as const
              ).find(([binding]) => matches([binding], native, apple));
              if (step && !native.getModifierState("AltGraph")) {
                event.preventDefault();
                restore.current = 0;
                highlight.move(step[1]);
                return;
              }
              // Other arrow chords, such as Shift+Down, edit the text.
              if (event.key === "ArrowDown" || event.key === "ArrowUp") return;
              // Control's letter keys step after the person's keys, in place
              // of the text field's own Emacs keys. Group keys only take
              // over while there are groups to show. An app shortcut that
              // runs inside search, such as one the person moved to one of
              // these, comes first: the window's dispatcher sees the key
              // after this field, so the step waits there and is skipped
              // once a shortcut has claimed the key.
              const control =
                native.ctrlKey &&
                !native.metaKey &&
                !native.altKey &&
                !native.shiftKey &&
                !native.getModifierState("AltGraph")
                  ? CONTROL_STEPS.get(event.key.toLowerCase())
                  : undefined;
              const host = event.currentTarget.ownerDocument.defaultView;
              if (
                host &&
                control &&
                (control[0] === "result" || (peek?.ranked && tabs.length))
              ) {
                const [kind, forward] = control;
                const step = (later: Event) => {
                  if (later !== native) return;
                  host.removeEventListener("keydown", step);
                  if (native.defaultPrevented) return;
                  native.preventDefault();
                  if (kind === "group") return void stepScope(forward);
                  restore.current = 0;
                  highlight.move(forward);
                };
                host.addEventListener("keydown", step);
                // A key stopped before the window edits the text as before.
                host.setTimeout(() =>
                  host.removeEventListener("keydown", step),
                );
                return;
              }
            }
            const shortcutNumber = /^Digit([1-9])$/.exec(event.code)?.[1];
            if (
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229 &&
              !event.altKey &&
              event.shiftKey &&
              event.metaKey === apple &&
              event.ctrlKey !== apple &&
              shortcutNumber
            ) {
              const destination = destinations[Number(shortcutNumber) - 1];
              if (destination) {
                event.preventDefault();
                if (!event.repeat) highlight.choose(destination.key);
              }
              return;
            }
            if (
              event.key === "Backspace" &&
              chips?.length &&
              event.currentTarget.selectionStart === 0 &&
              event.currentTarget.selectionEnd === 0
            ) {
              event.preventDefault();
              onEditLastChip?.();
              return;
            }
            // Tab completes a filter with its highlighted row, and stays in
            // the field while its suggestions are still loading. With nothing
            // to complete it moves on, so other controls stay in reach.
            if (
              completing &&
              event.key === "Tab" &&
              !event.shiftKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey &&
              !event.nativeEvent.isComposing
            ) {
              if (keys.includes(selected)) {
                event.preventDefault();
                if (!event.repeat) highlight.choose(selected);
                return;
              }
              if (completionPending) {
                event.preventDefault();
                return;
              }
            }
            // Tab moves between groups, and stays in the field while results
            // are still landing. Past the first or last group it moves on as
            // Tab does, so retry and other controls stay in reach.
            if (
              peek?.ranked &&
              event.key === "Tab" &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey
            ) {
              if (tabs.length ? stepScope(!event.shiftKey) : peek.busy)
                event.preventDefault();
              return;
            }
            // Escape from one group returns to Top results, or the first
            // group, not out of search.
            if (event.key === "Escape" && scoped && scoped.label !== home) {
              event.preventDefault();
              event.stopPropagation();
              showScope(undefined);
              return;
            }
            highlight.keyDown(event);
          }}
        />
        {peek?.hints}
      </div>
      <div className={previewing ? "search-peek-workspace" : "contents"}>
        {peek?.ranked && tabs.length > 0 && (
          // Escape from one group returns to Top results, from a filter
          // as from the field, not out of search.
          <fieldset
            className="search-peek-rail"
            aria-label="Result groups"
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !scoped || scoped.label === home)
                return;
              event.preventDefault();
              event.stopPropagation();
              showScope(undefined);
            }}
          >
            {(home ? tabs : [undefined, ...tabs]).map((group, index) => (
              <Button
                key={group?.label ?? ""}
                id={`${peekPanelId(group?.label)}-filter`}
                size="xs"
                data-leading-dot=""
                variant={
                  scoped?.label === group?.label ? "subtle" : "outline-subtle"
                }
                aria-pressed={scoped?.label === group?.label}
                aria-controls={peekPanelId(undefined)}
                onClick={() => {
                  if (scoped?.label !== group?.label)
                    showScope(group?.label, false);
                }}
              >
                <span
                  className="search-peek-filter-dot"
                  data-tone={group?.tone ?? "page"}
                  aria-hidden="true"
                />
                {group?.label === "Direct messages"
                  ? "DMs"
                  : (group?.label ?? "Top results")}
                {/* A landing group has no count yet. Top results has none:
                  it shows only the first rows of each group. */}
                {group && group !== landing && (
                  <span className="search-peek-count">{countOf(group)}</span>
                )}
                {index === 1 && group !== landing && !!query.trim() && (
                  <Badge size="xs" tone="success">
                    Best match
                  </Badge>
                )}
              </Button>
            ))}
          </fieldset>
        )}
        <div
          className={previewing ? "search-peek-body" : "contents"}
          {...(peek?.ranked && tabs.length > 0
            ? {
                role: "region",
                id: peekPanelId(undefined),
                "aria-labelledby": `${peekPanelId(scoped?.label)}-filter`,
              }
            : {})}
        >
          <div ref={resultsViewport} className="search-palette-height">
            <div
              ref={resultsContent}
              className="search-palette-scroll"
              onWheel={() => {
                restore.current = 0;
              }}
              onPointerDown={() => {
                restore.current = 0;
              }}
              onScroll={(event) => {
                if (restore.current) return;
                // Enter never chooses a row scrolled out of sight.
                if (selected && !inView(selected)) highlight.clear();
                if (!place) return;
                place.top = event.currentTarget.scrollTop;
                keepPlace();
              }}
            >
              {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: Both grid and listbox support an accessible label. */}
              <div
                id={highlight.listId}
                role={hasControls ? "grid" : "listbox"}
                aria-label={resultsLabel}
                aria-busy={peek?.busy || undefined}
                className="search-palette-results interaction-panel"
              >
                {groups
                  .filter(
                    ({ destinations, empty, headingStatus }) =>
                      destinations.length ||
                      empty !== undefined ||
                      headingStatus,
                  )
                  .map(
                    ({
                      label,
                      hideLabel,
                      destinations,
                      empty,
                      notice,
                      headingStatus,
                      why,
                      reranked,
                      tone,
                      multiline,
                    }) => {
                      const shown = truncated.get(label);
                      const count = countOf(
                        ranked.find((group) => group.label === label) ?? {
                          label,
                          destinations,
                        },
                      );
                      // The heading's cut and rerank mark are hidden from
                      // assistive technology, so the group describes them.
                      const summary = [
                        shown !== undefined && `Top ${shown} of ${count}`,
                        reranked && "Reranked",
                      ]
                        .filter(Boolean)
                        .join(", ");
                      const heading = (
                        <span
                          className={`navigation-section-label text-body text-secondary${headingStatus ? " truncate" : ""}`}
                        >
                          <span className="search-peek-group-label text-label-sm">
                            {label}
                          </span>
                          {peek?.ranked &&
                            ranked.some((group) => group.label === label) && (
                              <span
                                className="search-peek-count"
                                aria-hidden="true"
                              >
                                {" "}
                                {shown !== undefined && `· Top ${shown} of `}
                                {count}
                              </span>
                            )}
                          {why && (
                            <span
                              className="search-peek-why"
                              aria-hidden="true"
                            >
                              {" "}
                              · {why}
                            </span>
                          )}
                          {reranked && (
                            <SparklesIcon
                              size={12}
                              title="Reranked"
                              className="search-peek-reranked"
                            />
                          )}
                          {headingStatus && (
                            <span aria-hidden="true"> · {headingStatus}</span>
                          )}
                        </span>
                      );
                      return (
                        // biome-ignore lint/a11y/useAriaPropsSupportedByRole: Both grid rowgroups and listbox groups are named.
                        <div
                          key={label}
                          role={hasControls ? "rowgroup" : "group"}
                          aria-label={label}
                          aria-describedby={
                            summary
                              ? `${peekPanelId(label)}-summary`
                              : undefined
                          }
                          // A status-only group has no rows yet; busy states why.
                          aria-busy={
                            (!!headingStatus && !destinations.length) ||
                            undefined
                          }
                          className="search-palette-group"
                          data-tone={tone}
                        >
                          {summary && (
                            <span id={`${peekPanelId(label)}-summary`} hidden>
                              {summary}
                            </span>
                          )}
                          <div className="navigation-section" data-buzz-ui="">
                            {!hideLabel && (
                              <div
                                className="navigation-section-heading"
                                // A cut group's heading stays in view while
                                // its rows scroll, with the way to the rest.
                                data-search-cut={
                                  truncated.has(label) || undefined
                                }
                                aria-hidden={hasControls || undefined}
                              >
                                <h2 className="m-0 min-w-0 flex-1">
                                  {heading}
                                </h2>
                                {truncated.has(label) && (
                                  <Button
                                    variant="ghost"
                                    size="xs"
                                    aria-label={`Show all ${label}`}
                                    tabIndex={-1}
                                    onMouseDown={(event) =>
                                      event.preventDefault()
                                    }
                                    onClick={() => showScope(label)}
                                  >
                                    Show all
                                    <ArrowRightIcon
                                      size={14}
                                      aria-hidden="true"
                                    />
                                  </Button>
                                )}
                              </div>
                            )}
                            <div className="navigation-section-rows">
                              {virtual ? (
                                // Only the rows near the view are drawn; the
                                // highlighted one stays, for the field to point at.
                                // The heading above is well inside virtua's buffer,
                                // so no start margin is needed.
                                <div className="search-palette-virtual">
                                  <Virtualizer
                                    data={destinations}
                                    scrollRef={resultsContent}
                                    keepMounted={keepMounted}
                                  >
                                    {(row) => renderRow(row, multiline)}
                                  </Virtualizer>
                                </div>
                              ) : (
                                destinations.map((row) =>
                                  renderRow(row, multiline),
                                )
                              )}
                              {(notice ||
                                (!destinations.length && !headingStatus)) && (
                                <div
                                  role={hasControls ? "row" : "presentation"}
                                >
                                  <div
                                    role={
                                      hasControls ? "gridcell" : "presentation"
                                    }
                                  >
                                    {notice}
                                    {!destinations.length && (
                                      <p className="search-palette-group-empty">
                                        {empty ?? "No matching results."}
                                      </p>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    },
                  )}
              </div>
              {children && (
                <div className="search-palette-status">{children}</div>
              )}
            </div>
          </div>
        </div>
        {preview && !narrow && (
          <aside className="search-peek-side" aria-label="Preview">
            {/* Not live: the highlighted row is already announced, and the
              preview changes with every keystroke. */}
            <div className="search-peek-preview">
              {(() => {
                const row =
                  destinations.find(({ key }) => key === selected) ??
                  (selected
                    ? undefined
                    : destinations.find(({ key }) => !isAction?.(key)));
                return preview(
                  row,
                  row &&
                    (row.kind ??
                      merged.find((group) =>
                        group.destinations.some(({ key }) => key === row.key),
                      )?.tone),
                  moved ? undefined : { text: query, busy: !!peek.busy },
                );
              })()}
            </div>
          </aside>
        )}
      </div>
      {footer && <div className="search-palette-footer">{footer}</div>}
      {previewing && (
        <div
          className="search-peek-keys text-caption text-subtle"
          aria-hidden="true"
        >
          <span>
            <kbd>{formatBinding(steps.previous, apple).text}</kbd>
            <kbd>{formatBinding(steps.next, apple).text}</kbd> Move
          </span>
          {ranked.length > 0 && (
            <span>
              <kbd>Tab</kbd> Next group
            </span>
          )}
          {ranked.length > 0 && (
            <span>
              <kbd>⇧</kbd>
              <kbd>Tab</kbd> Previous
            </span>
          )}
          <span>
            <kbd>↵</kbd> {onBack ? "Add" : "Open"}
          </span>
          {conversationShortcut && (
            <span>
              <kbd>{formatBinding(conversationShortcut, apple).text}</kbd> This
              conversation
            </span>
          )}
          <span>
            <kbd>esc</kbd>{" "}
            {onBack
              ? "Back"
              : scoped && scoped.label !== home
                ? `Back to ${home ?? "top"}`
                : "Close"}
          </span>
        </div>
      )}
    </div>
  );
}
