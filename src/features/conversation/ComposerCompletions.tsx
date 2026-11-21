import { withHumanMentionSelection } from "../messages/mention-draft";
import {
  readComposerSnapshot,
  composerMarkdownContext,
} from "../messages/composer-document";
import {
  mentionTerminator,
  type ComposerSnapshot,
} from "../messages/mention-draft";
import { scanMarkdown } from "../relay/message-content";
import type { ComposerInputElement } from "../messages/composer-dom";
import { createPortal } from "react-dom";
import { RobotIcon } from "../../shared/design-system/icons/index";
import { useCompletionPosition } from "./useCompletionPosition";
import {
  useId,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerCompletion,
  ComposerCompletionProps,
  CompletionContext,
  CompletionQuery,
  CompletionResult,
  ComposerObservation,
  ContributionReader,
  IdentityMark,
} from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";
import { IdentityMarks } from "./IdentityMarks";
import {
  completionResult,
  matchCompletion,
  type CompletionMatch,
  type HostCompletionEdit,
  type HostCompletionResult,
  type HostCompletionSuggestion,
} from "./completion";
import type { CompletionEditor } from "./useCompletionEditor";
import styles from "./Completions.module.css";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";

/** The editor retains focus, so keyboard selection must open its own hint. */
function EmojiCompletionName({
  label,
  selected,
  keyboardSelected,
}: {
  label: string;
  selected: boolean;
  keyboardSelected: boolean;
}) {
  const name = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);
  const [hovered, setHovered] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Text can change overflow without resizing the label's box.
  useLayoutEffect(() => {
    const element = name.current;
    if (!element) return;
    const measure = () =>
      setTruncated(element.scrollWidth > element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [label]);
  return (
    <Tooltip
      content={label}
      open={truncated && selected && (keyboardSelected || hovered)}
      onOpenChange={setHovered}
      follow={keyboardSelected ? "trigger" : "pointer"}
    >
      <span ref={name} className={styles.name}>
        {label}
      </span>
    </Tooltip>
  );
}

/** What the popup shows, owned by the host across the per-query remount of
 * `OwnedCompletion`. A keystroke that continues an open query (same provider,
 * same trigger) mounts a new owner; its first commit used to close the popup
 * until the provider's mount effect published, a paint later. The new owner
 * now shows the previous query's result until its own first publication
 * replaces it in the same task: a store update renders synchronously, and an
 * owner whose provider has not published by the end of its mount effects
 * clears it. A query opened elsewhere, by another provider, or after the
 * popup closed starts empty: `ComposerCompletions` evicts the store in its
 * closed render, so a carried result means only a continuing open query. */
type Shown = Readonly<Record<number, HostCompletionResult>>;
function createDisplay() {
  let shown: { key: string; results: Shown | undefined } = {
    key: "",
    results: undefined,
  };
  const listeners = new Set<() => void>();
  return {
    read: (key: string) => (shown.key === key ? shown.results : undefined),
    set(key: string, source?: number, result?: HostCompletionResult) {
      const results: Record<number, HostCompletionResult> =
        shown.key === key ? { ...shown.results } : {};
      if (source !== undefined) {
        if (result) results[source] = result;
        else delete results[source];
      }
      shown = { key, results: key ? results : undefined };
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// Channel links belong in prose, not inside existing links or code.
// Run only after a channel trigger matches; ordinary typing does no extra parsing.
function channelCompletionInProse(
  text: string,
  document: ComposerSnapshot | undefined,
  query: CompletionQuery,
) {
  const doc = readComposerSnapshot(document);
  const context = doc ? composerMarkdownContext(doc) : { text, protected: [] };
  const overlaps = (start: number, end: number) =>
    query.start < end && query.end > start;
  if (context.protected.some(({ start, end }) => overlaps(start, end)))
    return false;
  const { tree, tooDeep } = scanMarkdown(context.text);
  if (tooDeep) return false;
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined || !overlaps(start, end))
      continue;
    if (
      [
        "code",
        "inlineCode",
        "link",
        "linkReference",
        "image",
        "imageReference",
        "definition",
        "html",
      ].includes(node.type)
    )
      return false;
    pending.push(...(node.children ?? []));
  }
  return true;
}

export function ComposerCompletions({
  registry,
  identityMarks,
  editor,
  input,
  replace,
  resolved,
  ...context
}: CompletionContext & {
  registry: ContributionReader<ComposerCompletion>;
  identityMarks?: ContributionReader<IdentityMark> | undefined;
  editor: CompletionEditor;
  input: RefObject<ComposerInputElement | null>;
  /** Chip ranges and the draft text they were measured against. */
  resolved: Readonly<{
    text: string;
    document?: ComposerSnapshot;
    recipients: readonly Readonly<{ start: number; end: number }>[];
    /** Mentions still resolving; their `@` is no more an open query. */
    pending?: readonly Readonly<{ start: number; end: number }>[] | undefined;
    tokens?: readonly Readonly<{ start: number; end: number }>[] | undefined;
  }>;
  replace(
    edit: HostCompletionEdit,
    query: CompletionQuery,
    observation: ComposerObservation,
    key?: string,
  ): boolean;
}) {
  const providers = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const [display] = useState(createDisplay);
  // Only user navigation pins an ID; automatic selection follows the first result.
  const [pin, setPin] = useState<{ scope: string; row?: string | undefined }>();
  // Query owners remount on typing. Keep the last physical position with the
  // host, recording after row handlers have compared the previous position.
  const pointerPosition =
    useRef<Pick<PointerEvent, "clientX" | "clientY">>(undefined);
  useEffect(() => {
    const document = input.current?.ownerDocument;
    if (!document) return;
    const record = (event: PointerEvent) => {
      pointerPosition.current = {
        clientX: event.clientX,
        clientY: event.clientY,
      };
    };
    document.addEventListener("pointermove", record);
    return () => document.removeEventListener("pointermove", record);
  }, [input]);
  const observation = editor.observation;
  // Stale chip ranges cannot classify this caret.
  const match =
    observation &&
    resolved.text === observation.text &&
    matchCompletion(providers, observation, context, [
      ...resolved.recipients,
      ...(resolved.pending ?? []),
      ...(resolved.tokens ?? []),
    ]);
  const scope = JSON.stringify(
    match && observation
      ? [
          contributionKey(match.provider),
          observation.revision,
          match.query.start,
          match.query.end,
          match.query.query,
        ]
      : null,
  );
  const select = useCallback(
    (row: SetStateAction<string | undefined>) =>
      setPin((previous) => {
        const held = previous?.scope === scope ? previous.row : undefined;
        const next = typeof row === "function" ? row(held) : row;
        return next === held ? previous : { scope, row: next };
      }),
    [scope],
  );
  const open =
    !!match &&
    !!observation &&
    (match.provider.pluginId !== "buzz.channels" ||
      channelCompletionInProse(
        observation.text,
        resolved.document,
        match.query,
      ));
  // A closed popup carries nothing on. A query reopened at the same trigger,
  // after Escape, Backspace through its `@`, a send or a pending-mention hold
  // that returned to text, starts empty as a first query does; its provider's
  // first publication fills it in the same task.
  useEffect(() => {
    if (!open) display.set("");
  }, [open, display]);
  if (!open || !match || !observation) return null;
  return (
    <ContributionBoundary
      key={JSON.stringify([
        scope,
        match.supplements.map(({ provider, query }) => [
          contributionKey(provider),
          query.end,
          query.query,
        ]),
      ])}
      fallback={
        <span role="status">
          {match.provider.title} suggestions unavailable
        </span>
      }
    >
      <OwnedCompletion
        {...context}
        registry={registry}
        identityMarks={identityMarks}
        display={display}
        provider={match.provider}
        sources={match.sources}
        query={match.query}
        observation={observation}
        editor={editor}
        input={input}
        replace={replace}
        pointerPosition={pointerPosition}
        selected={pin?.scope === scope ? pin.row : undefined}
        setSelected={select}
      />
    </ContributionBoundary>
  );
}
type Row = Readonly<{
  source: CompletionMatch;
  key: string;
  item?: HostCompletionSuggestion;
  heading?: string;
}>;
const slot = ({ provider }: CompletionMatch) => contributionKey(provider);
const rowKey = (source: CompletionMatch, id?: string) =>
  JSON.stringify([slot(source), id ?? null]);

function OwnedCompletion({
  provider,
  sources: matched,
  registry,
  identityMarks,
  display,
  query,
  observation,
  editor,
  input,
  replace,
  pointerPosition,
  selected,
  setSelected,
  ...context
}: CompletionContext & {
  selected: string | undefined;
  setSelected: Dispatch<SetStateAction<string | undefined>>;
  provider: Contribution<ComposerCompletion>;
  sources: readonly CompletionMatch[];
  registry: ContributionReader<ComposerCompletion>;
  identityMarks?: ContributionReader<IdentityMark> | undefined;
  display: ReturnType<typeof createDisplay>;
  query: CompletionQuery;
  observation: ComposerObservation;
  editor: CompletionEditor;
  input: RefObject<ComposerInputElement | null>;
  pointerPosition: RefObject<
    Pick<PointerEvent, "clientX" | "clientY"> | undefined
  >;
  replace(
    edit: HostCompletionEdit,
    query: CompletionQuery,
    observation: ComposerObservation,
    key?: string,
  ): boolean;
}) {
  const id = useId();
  const compact = provider.pluginId === "buzz.emoji";
  const mention = provider.pluginId === "buzz.mentions";
  const channel = provider.pluginId === "buzz.channels";
  const named = mention || channel;
  // Typing a terminator accepts the provider-verified exact match (spaceId):
  // plain Space after a name, closing punctuation after a mention too, and the
  // closing colon after an emoji shortcode.
  const terminates = (key: string) =>
    compact ? key === ":" : mention ? mentionTerminator(key) : key === " ";
  const popup = useCompletionPosition(
    input,
    compact ? 0.375 : 1,
    named
      ? { preferAbove: true, gap: 4, maxWidth: channel ? 480 : 380 }
      : undefined,
  );
  const list = useRef<HTMLDivElement>(null);
  const trigger = `${contributionKey(provider)}:${query.start}`;
  const [sources] = useState(matched);
  const results = useSyncExternalStore(
    display.subscribe,
    () => display.read(trigger),
    () => display.read(trigger),
  );
  const result = results?.[contributionKey(provider)];
  // This lifetime's own publication; a carried display is never acted on.
  const latest = useRef(new Map<number, HostCompletionResult>());
  const failed = useRef(new Set<number>());
  const [keyboardSelection, setKeyboardSelection] = useState<string>();
  const pointerMoved = useCallback(
    (event: Pick<PointerEvent, "clientX" | "clientY">) => {
      const previous = pointerPosition.current;
      return (
        !previous ||
        previous.clientX !== event.clientX ||
        previous.clientY !== event.clientY
      );
    },
    [pointerPosition],
  );
  useEffect(() => {
    const document = input.current?.ownerDocument;
    if (!compact || !document) return;
    const pointer = (event: PointerEvent) => {
      if (!pointerMoved(event)) return;
      setKeyboardSelection(undefined);
    };
    // Capture before the host's bubbling listener records this event.
    document.addEventListener("pointermove", pointer, true);
    return () => document.removeEventListener("pointermove", pointer, true);
  }, [compact, input, pointerMoved]);
  const revealSelection = useRef(false);
  const live = useRef(false);
  const current = useRef({ editor, replace });
  useLayoutEffect(() => {
    current.current = { editor, replace };
  });
  const active = useCallback(
    (candidate: Contribution<ComposerCompletion>) =>
      live.current &&
      !failed.current.has(contributionKey(candidate)) &&
      registry.snapshot().includes(candidate) &&
      current.current.editor.valid(observation),
    [registry, observation],
  );
  const [publishers, setPublishers] =
    useState<readonly ComposerCompletionProps["publish"][]>();
  useLayoutEffect(() => {
    live.current = true;
    let owned = true;
    const published = latest.current;
    setPublishers(
      sources.map((source) => (incoming: CompletionResult) => {
        if (!owned || !active(source.provider)) return false;
        const next = completionResult(incoming, source.provider);
        published.set(slot(source), next);
        revealSelection.current = true;
        display.set(trigger, slot(source), next);
        setSelected((previous) => {
          if (!previous?.startsWith(`[${slot(source)},`)) return previous;
          const kept =
            previous === rowKey(source)
              ? !!next.retry
              : next.items.some((item) => previous === rowKey(source, item.id));
          return kept ? previous : undefined;
        });
        return () => {
          if (published.get(slot(source)) !== next) return;
          published.delete(slot(source));
          if (live.current) display.set(trigger, slot(source));
        };
      }),
    );
    return () => {
      owned = false;
      live.current = false;
      published.clear();
    };
  }, [active, display, sources, trigger, setSelected]);
  // A carried result stands only until this query's provider has run its
  // mount effects, which precede this one; a provider that has not published
  // by then leaves the popup closed, as for a first query, so a stale display
  // is never painted.
  useEffect(() => {
    if (!publishers) return;
    for (const key of Object.keys(display.read(trigger) ?? {}))
      if (!latest.current.has(Number(key))) display.set(trigger, Number(key));
  }, [publishers, display, trigger]);
  const held = () =>
    sources.some((source) => {
      const published = latest.current.get(slot(source));
      return (
        source.provider !== provider &&
        !failed.current.has(slot(source)) &&
        published?.holdAutoSelect === true
      );
    });
  const isolate = (source: CompletionMatch, node: ReactNode) =>
    source.provider === provider ? (
      node
    ) : (
      <ContributionBoundary
        key={slot(source)}
        fallback={null}
        onFailedChange={(failure) => {
          if (!failure) return;
          failed.current.add(slot(source));
          display.set(trigger, slot(source));
        }}
      >
        {node}
      </ContributionBoundary>
    );
  const rows: Row[] = [];
  for (const source of sources) {
    const shown = results?.[slot(source)];
    const own: Row[] = [
      ...(shown?.items ?? []).map((item) => ({
        source,
        key: rowKey(source, item.id),
        item,
      })),
      ...(shown?.retry ? [{ source, key: rowKey(source) }] : []),
    ];
    const first = own[0];
    if (
      first &&
      (source.provider !== provider || (rows.length > 0 && !first.item?.group))
    )
      own[0] = { ...first, heading: source.provider.title };
    rows.push(...own);
  }
  const statuses = sources.flatMap((source) => {
    const status = results?.[slot(source)]?.status;
    return status ? [{ source, status }] : [];
  });
  const lines = rows.map((row, i) => {
    const { item, source } = row;
    const lead = rows.findIndex((other) => other.source === source);
    const group = item?.group;
    return {
      ...row,
      heading:
        row.heading ?? (group !== rows[i - 1]?.item?.group ? group : undefined),
      described: group
        ? `${id}-group-${rows.findIndex((other) => other.item?.group === group)}`
        : rows[lead]?.heading
          ? `${id}-group-${lead}`
          : undefined,
    };
  });
  // Matching syntax is not evidence of pending work. Providers publish their
  // own status when needed; an empty/unpublished result must not flash a portal.
  const visible = !!(rows.length || statuses.length);
  const count = rows.length;
  const index = rows.findIndex((row) => row.key === selected);
  const selectedIndex = index < 0 ? 0 : index;
  function accept(index: number, event: Event, key = "click") {
    const terminator = terminates(key);
    const row = terminator ? undefined : rows[index];
    const source = row?.source ?? { provider, query };
    const published = latest.current.get(slot(source));
    if (!active(source.provider) || !published) return false;
    if (row && !row.item) {
      if (!published.retry) return false;
      published.retry();
      return true;
    }
    // Publication is synchronous; React may still be displaying the previous
    // result. Keep the user's chosen ID, but use only its current evidence/edit.
    // The terminator names its own item, which that display may not have yet.
    const id = terminator ? published.spaceId : row?.item?.id;
    const item = published.items.find((item) => item.id === id);
    if (!item || item.disabled || item.canSelect?.(key) === false) return false;
    const accepted = withHumanMentionSelection(event, () =>
      current.current.replace(item.edit, source.query, observation, key),
    );
    if (accepted) current.current.editor.invalidate();
    return accepted;
  }
  useLayoutEffect(() => {
    const element = input.current;
    // Escape must still dismiss an unpublished provider without advertising a
    // nonexistent listbox. A settled empty result leaves ordinary keys alone;
    // an undecided one still owns the terminator, with nothing to show yet.
    if (!element || (!visible && result && !result.spacePending && !held()))
      return;
    if (visible) {
      element.setAttribute("aria-autocomplete", "list");
      element.setAttribute("aria-haspopup", "listbox");
      element.setAttribute("aria-controls", id);
      if (count)
        element.setAttribute("aria-activedescendant", `${id}-${selectedIndex}`);
      else element.removeAttribute("aria-activedescendant");
    }
    const handle: NonNullable<CompletionEditor["keys"]["current"]> = (
      event,
    ) => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
        return false;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        current.current.editor.invalidate();
        return true;
      }
      // Option types curly quotes and, on some Mac layouts, other closing
      // punctuation, so it may close a mention; elsewhere it keeps editing.
      if (event.ctrlKey || event.metaKey || (event.altKey && !mention))
        return false;
      // Shift types ":" and closing punctuation on common layouts; other
      // modified keys, Space included, keep editing.
      if (
        (event.shiftKey || event.altKey) &&
        (event.key === " " || !terminates(event.key))
      )
        return false;
      if (!active(provider)) {
        // A displayed choice owns plain acceptance even when its final evidence
        // was revoked. Never turn a rejected edit into an unintended send.
        if ((event.key === "Enter" || event.key === "Tab") && count) {
          event.preventDefault();
          event.stopPropagation();
          current.current.editor.invalidate();
          return true;
        }
        return false;
      }
      // A result that has just decided the terminator may not have rendered
      // yet, so both terminator branches read the publication. Space is not
      // redirected away from an exact match the display showed: a publication
      // that moves it to another id leaves Space literal. The displayed row
      // is never accepted on its own; only the publication selects.
      const published = held()
        ? undefined
        : latest.current.get(contributionKey(provider));
      if (
        terminates(event.key) &&
        published?.spaceId &&
        (!result?.spaceId || result.spaceId === published.spaceId)
      ) {
        // Selected by ID, so no displayed row is needed.
        if (accept(-1, event.nativeEvent, event.key)) {
          event.preventDefault();
          event.stopPropagation();
          return true;
        }
        return false;
      }
      // Undecided, not declined: the provider is still gathering evidence, so
      // the host may hold the name as a pending mention and resolve it later.
      // This includes a display whose exact match the publication withdrew
      // as undecided: no other recipient overrules what the user saw, the
      // decision is deferred to the resolver under the full rule.
      const spacePending = published?.spacePending;
      if (
        terminates(event.key) &&
        spacePending &&
        !published?.spaceId &&
        withHumanMentionSelection(event.nativeEvent, () =>
          current.current.replace(
            { pending: spacePending },
            query,
            observation,
            event.key,
          ),
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
        current.current.editor.invalidate();
        return true;
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count) {
        event.preventDefault();
        event.stopPropagation();
        const next =
          (selectedIndex + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
        revealSelection.current = true;
        if (compact) setKeyboardSelection(rows[next]?.key);
        setSelected(rows[next]?.key);
        return true;
      }
      if ((event.key === "Enter" || event.key === "Tab") && count) {
        event.preventDefault();
        event.stopPropagation();
        accept(selectedIndex, event.nativeEvent, event.key);
        return true;
      }
      return false;
    };
    editor.keys.current = handle;
    if (revealSelection.current) {
      list.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
      revealSelection.current = false;
    }
    return () => {
      if (editor.keys.current === handle) editor.keys.current = undefined;
      element.removeAttribute("aria-autocomplete");
      element.removeAttribute("aria-haspopup");
      element.removeAttribute("aria-controls");
      element.removeAttribute("aria-activedescendant");
    };
  });
  return (
    <>
      {publishers &&
        sources.map((source, i) => {
          const Provider = source.provider.component;
          const publish = publishers[i];
          if (!publish) return null;
          return isolate(
            source,
            <Provider
              key={slot(source)}
              {...context}
              observation={observation}
              query={source.query}
              publish={publish}
            />,
          );
        })}
      {visible &&
        input.current &&
        createPortal(
          <section
            ref={popup}
            className={styles.popup}
            aria-label={`${provider.title} suggestions`}
            data-compact={compact || undefined}
            data-mention={named || undefined}
            data-channel={channel || undefined}
          >
            <div
              id={id}
              role="listbox"
              aria-label={`${provider.title} suggestions`}
              ref={list}
              className={styles.list}
            >
              {lines.flatMap(({ item, source, key, heading, described }, i) => [
                heading && (
                  // Read as the description of each row it heads.
                  <div
                    key={`group:${key}`}
                    id={`${id}-group-${i}`}
                    aria-hidden="true"
                    className={styles.group}
                  >
                    {heading}
                  </div>
                ),
                // The textarea owns keyboard focus/selection via aria-activedescendant.
                // biome-ignore lint/a11y/useKeyWithClickEvents: Keyboard acceptance belongs to the focused textarea.
                <div
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === selectedIndex}
                  aria-disabled={item && !!item.disabled}
                  aria-label={
                    compact && item?.detail
                      ? `${item.label} ${item.detail}`
                      : undefined
                  }
                  id={`${id}-${i}`}
                  // The provider's identity for the row (a mention's key),
                  // which its label no longer spells out.
                  data-completion-id={item?.id}
                  key={key}
                  aria-describedby={described}
                  onPointerDown={(event) => {
                    if (event.button === 0) event.preventDefault();
                  }}
                  onPointerMove={
                    compact || named
                      ? (event) => {
                          // WebKit can report a pointermove when keyboard
                          // scrolling moves another row under a resting pointer.
                          if (compact && !pointerMoved(event)) return;
                          revealSelection.current = false;
                          setKeyboardSelection(undefined);
                          setSelected(key);
                        }
                      : undefined
                  }
                  onClick={(event) => accept(i, event.nativeEvent)}
                  className={styles.option}
                >
                  {item?.preview && (
                    <span aria-hidden="true" className={styles.preview}>
                      {isolate(source, item.preview)}
                    </span>
                  )}
                  {item && (
                    <span className={styles.label} data-completion-label>
                      {compact ? (
                        <EmojiCompletionName
                          label={item.label}
                          selected={i === selectedIndex}
                          keyboardSelected={keyboardSelection === key}
                        />
                      ) : named ? (
                        // Only the name ellipsizes; the agent mark stays visible.
                        <span className={styles.nameRow}>
                          <span className={styles.name}>{item.label}</span>
                          {mention &&
                            source.provider === provider &&
                            item.edit.mention && (
                              <IdentityMarks
                                registry={identityMarks}
                                pubkey={item.edit.mention.pubkey}
                                profiles={context.session.profiles}
                                className={styles.identityMarks}
                              />
                            )}
                          {item.agent && (
                            <span
                              aria-hidden="true"
                              className={styles.agentMark}
                            >
                              <RobotIcon />
                            </span>
                          )}
                          {item.agent && (
                            <span className="sr-only"> Agent</span>
                          )}
                        </span>
                      ) : (
                        item.label
                      )}
                      {item.detail && (
                        <small aria-hidden={compact || undefined}>
                          {item.detail}
                        </small>
                      )}
                    </span>
                  )}
                  {channel && item && i === selectedIndex && (
                    <span aria-hidden="true" className={styles.acceptKey}>
                      Enter
                    </span>
                  )}
                  {!item &&
                    (source.provider === provider
                      ? "Retry suggestions"
                      : `Retry ${source.provider.title} suggestions`)}
                </div>,
              ])}
            </div>
            {statuses.map(({ source, status }) => (
              <p role="status" key={slot(source)}>
                {status}
              </p>
            ))}
          </section>,
          // A body sibling would sit behind a fullscreen modal and outside its
          // accessibility boundary. Ordinary composers keep the body portal.
          input.current.closest('[role="dialog"][aria-modal="true"]') ??
            input.current.ownerDocument.body,
        )}
    </>
  );
}
