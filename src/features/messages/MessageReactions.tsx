import { useConversationPresentation } from "../conversation/ConversationPresentation";
import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { PreviewCard } from "../../shared/design-system/ui/PreviewCard";
import { ReactionDelivery, ReactionTool } from "../conversation/ReactionTool";
import type {
  ComposerTool,
  ContributionReader,
  InlineRenderer,
} from "../conversation/contracts";
import type {
  ChannelMessage,
  MessageReaction,
  Profile,
} from "../relay/contracts";
import type { CustomEmoji } from "../relay/emoji";
import type { RelaySession } from "../relay/session";
import type { OutgoingEvent } from "../relay/outbox";
import { selectProfiles } from "../relay/profile-selection";
import styles from "./Messages.module.css";
import { isUnicodeEmojiOnly } from "./emoji-size";

type Props = {
  row: ChannelMessage;
  session: RelaySession;
  scope: string;
  disabled: boolean;
  tools: ContributionReader<ComposerTool>;
  inline: ContributionReader<InlineRenderer>;
};
const noSubscribe = () => () => {};
const noOperations = Object.freeze([]);
const empty = () => noOperations;

function useReactionAction({ row, session, disabled }: Props) {
  const presented = useConversationPresentation();
  const [error, setError] = useState<string>();
  const active = useRef(false);
  useLayoutEffect(() => {
    active.current = !disabled && presented;
  });
  useLayoutEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  const operations = useSyncExternalStore(
    session.outbox?.subscribe ?? noSubscribe,
    session.outbox?.snapshot ?? empty,
    session.outbox?.snapshot ?? empty,
  );
  const blocksToggle = (item: OutgoingEvent) =>
    ["sending", "failed", "unknown"].includes(item.delivery) &&
    session.messages.reactionTarget(item.event) === row.id;
  const busy = operations.some(blocksToggle);
  const toggle = (content: string, emoji?: CustomEmoji) => {
    if (!active.current || session.outbox?.snapshot().some(blocksToggle))
      return false;
    try {
      const group = row.reactions.find(
        (reaction) =>
          reaction.content === content && reaction.emoji?.url === emoji?.url,
      );
      const mine =
        group?.events.filter((event) => event.authorId === session.viewer) ??
        [];
      if (mine.length) session.messages.remove(mine.map((event) => event.id));
      else {
        session.messages.react(row.id, content, emoji);
      }
      setError(undefined);
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not update reaction. Try again.",
      );
      return false;
    }
  };
  return { toggle, disabled: disabled || busy, busy, error };
}

const catalogIndexes = new WeakMap<
  readonly CustomEmoji[],
  ReadonlyMap<string, CustomEmoji>
>();
/** Resolve picker selections against one index per custom-emoji catalog snapshot. */
function catalogEmoji(entries: readonly CustomEmoji[], content: string) {
  if (!content.startsWith(":")) return undefined;
  let index = catalogIndexes.get(entries);
  if (!index) {
    index = new Map(entries.map((entry) => [`:${entry.shortcode}:`, entry]));
    catalogIndexes.set(entries, index);
  }
  return index.get(content.toLowerCase());
}

/** The emoji contribution owns the single reaction-picker action. */
export function MessageReactionControls(props: Props) {
  const { row, session, scope, tools } = props;
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  const action = useReactionAction(props);
  const select = (content: string) =>
    action.toggle(content, catalogEmoji(catalog.entries, content));
  return (
    <>
      <ReactionTool
        registry={tools}
        session={session}
        scope={scope}
        messageId={row.id}
        disabled={action.disabled}
        select={select}
        showDelivery={false}
      />
      {action.error && <span role="alert">{action.error}</span>}
    </>
  );
}

function ReactionGlyph({
  reaction,
  session,
}: {
  reaction: MessageReaction;
  session: RelaySession;
}) {
  const source = reaction.emoji ? session.media(reaction.emoji.url) : undefined;
  const [failed, setFailed] = useState<string>();
  return source && source !== failed ? (
    <img
      className={styles.reactionCustomEmoji}
      src={source}
      alt=""
      draggable={false}
      onError={() => setFailed(source)}
    />
  ) : (
    <span
      className={
        reaction.emoji
          ? styles.reactionFallbackEmoji
          : styles.reactionNativeEmoji
      }
      data-reaction-artwork={
        (!reaction.emoji && isUnicodeEmojiOnly(reaction.content)) || undefined
      }
      aria-hidden="true"
    >
      {reaction.emoji ? `:${reaction.emoji.shortcode}:` : reaction.content}
    </span>
  );
}

/** Mounted by PreviewCard's portal: closed pills do not observe the full roster. */
function ReactionPreviewContent({
  reaction,
  authorIds,
  session,
  profiles,
  name,
  previewTilt,
  peopleList,
  overflowing,
  onOverflow,
}: {
  reaction: MessageReaction;
  authorIds: string[];
  session: RelaySession;
  profiles: ReadonlyMap<string, Profile> | undefined;
  name: string;
  previewTilt: string;
  peopleList: RefObject<HTMLElement | null>;
  overflowing: boolean;
  onOverflow(overflowing: boolean): void;
}) {
  const previewAuthors = useMemo(() => {
    return session.viewer && authorIds.includes(session.viewer)
      ? [session.viewer, ...authorIds.filter((id) => id !== session.viewer)]
      : authorIds;
  }, [authorIds, session.viewer]);
  const reactorProfiles = useMemo(
    () => selectProfiles(session.profiles, previewAuthors),
    [session.profiles, previewAuthors],
  );
  const loadedReactors = useSyncExternalStore(
    reactorProfiles.subscribe,
    reactorProfiles.snapshot,
    reactorProfiles.snapshot,
  );
  const users = previewAuthors.map((authorId) =>
    authorId === session.viewer
      ? "You"
      : (loadedReactors.get(authorId)?.name ??
        profiles?.get(authorId)?.name ??
        authorId.slice(0, 10)),
  );
  // Opening enriches a small first page, never pointer transit across a pill.
  useEffect(() => {
    void session.profiles
      .ensure(previewAuthors.slice(0, 32), "background")
      .catch(() => {});
  }, [session.profiles, previewAuthors]);
  const observePeople = useCallback(
    (element: HTMLElement | null) => {
      peopleList.current = element;
      if (!element) return;
      const measure = () => {
        onOverflow(element.scrollHeight > element.clientHeight);
      };
      measure();
      const resize =
        typeof ResizeObserver === "undefined"
          ? undefined
          : new ResizeObserver(measure);
      resize?.observe(element);
      if (element.firstElementChild) resize?.observe(element.firstElementChild);
      const visible =
        typeof IntersectionObserver === "undefined"
          ? undefined
          : new IntersectionObserver(
              (entries) => {
                const ids = entries
                  .filter((entry) => entry.isIntersecting)
                  .map((entry) => (entry.target as HTMLElement).dataset.author)
                  .filter((id): id is string => !!id);
                for (let start = 0; start < ids.length; start += 32)
                  void session.profiles
                    .ensure(ids.slice(start, start + 32), "background")
                    .catch(() => {});
              },
              { root: element },
            );
      for (let index = 0; index < previewAuthors.length; index++) {
        const person = element.firstElementChild?.children.item(index);
        if (person) visible?.observe(person);
      }
      return () => {
        resize?.disconnect();
        visible?.disconnect();
      };
    },
    [session.profiles, previewAuthors, peopleList, onOverflow],
  );
  return (
    <div className={styles.reactionPreviewContent}>
      <span
        className={styles.reactionPreviewEmoji}
        style={{ "--reaction-preview-tilt": previewTilt } as CSSProperties}
      >
        <ReactionGlyph reaction={reaction} session={session} />
      </span>
      <section
        ref={observePeople}
        className={styles.reactionPreviewNames}
        aria-label="Everyone who reacted"
        tabIndex={overflowing ? 0 : undefined}
      >
        <div>
          {previewAuthors.map((authorId, index) => (
            <span key={authorId} data-author={authorId}>
              {index > 0 ? ", " : ""}
              {users[index]}
            </span>
          ))}
        </div>
      </section>
      <span className={styles.reactionPreviewName}>{name}</span>
    </div>
  );
}

function ReactionEmoji({
  reaction,
  authorIds,
  mine,
  session,
  profiles,
  disabled,
  busy,
  toggle,
  onFocusedRemoval,
  previewWarm,
  previewSlide,
  previewOpen,
  onPreviewChange,
}: {
  reaction: MessageReaction;
  authorIds: string[];
  mine: boolean;
  session: RelaySession;
  profiles?: ReadonlyMap<string, Profile> | undefined;
  disabled: boolean;
  busy: boolean;
  toggle(content: string, emoji?: CustomEmoji): boolean;
  onFocusedRemoval?: (() => void) | undefined;
  previewWarm: boolean;
  previewSlide: "left" | "right" | undefined;
  previewOpen: boolean;
  onPreviewChange(open: boolean): void;
}) {
  const [name, setName] = useState(reaction.content);
  // A retained focus must not reopen the preview over delivery recovery controls.
  // Fresh pointer or keyboard entry can reveal it again.
  const [previewDismissed, setPreviewDismissed] = useState(false);
  const [previewTilt, setPreviewTilt] = useState("0deg");
  const emojiAnchor = useRef<HTMLSpanElement>(null);
  const peopleList = useRef<HTMLElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const unavailable = disabled || busy;
  // Who reacted stays readable to people who cannot react.
  const shown = previewOpen && !previewDismissed && !busy;
  const grouped = authorIds.length > 1;
  const labelProfiles = useMemo(
    () => selectProfiles(session.profiles, grouped ? [] : authorIds),
    [session.profiles, grouped, authorIds],
  );
  const loadedLabel = useSyncExternalStore(
    grouped ? noSubscribe : labelProfiles.subscribe,
    labelProfiles.snapshot,
    labelProfiles.snapshot,
  );
  const authorId = authorIds[0] ?? "";
  const user =
    authorId === session.viewer
      ? "You"
      : (loadedLabel.get(authorId)?.name ??
        profiles?.get(authorId)?.name ??
        authorId.slice(0, 10));
  const revealName = () => {
    if (reaction.emoji) return;
    void import("./reaction-name").then(({ reactionName }) =>
      setName(reactionName(reaction.content)),
    );
  };
  return (
    <span
      className={`${styles.reactionItem} buzz-compact-controls`}
      data-mine={mine || undefined}
    >
      <PreviewCard
        side="top"
        align="center"
        anchor={emojiAnchor}
        open={shown}
        warm={previewWarm}
        // Scrollability must not change positioning and its measured available height.
        sticky
        {...(overflowing && {
          actionRef: peopleList,
          "aria-label": `People who reacted with ${name}`,
        })}
        className={[
          styles.reactionPreview,
          previewSlide === "left" && styles.reactionPreviewSlideLeft,
          previewSlide === "right" && styles.reactionPreviewSlideRight,
        ]
          .filter(Boolean)
          .join(" ")}
        onOpenChange={onPreviewChange}
        trigger={
          <Button
            variant="plain"
            size={grouped ? "caption" : "sm"}
            shape={grouped ? "capsule" : "icon"}
            data-reaction={reaction.content}
            data-reaction-url={reaction.emoji?.url}
            aria-label={`${reaction.content}: ${grouped ? `${authorIds.length} people` : user}`}
            aria-pressed={mine}
            // Not disabled: hover, focus and Tab into the preview stay
            // available, and keys reach ancestors. onClick rejects activation.
            aria-disabled={unavailable}
            onMouseEnter={(event) => {
              setPreviewDismissed(false);
              const tilt = `${Math.random() * 20 - 10}deg`;
              event.currentTarget.style.setProperty("--reaction-tilt", tilt);
              setPreviewTilt(tilt);
              revealName();
            }}
            onFocus={() => {
              setPreviewDismissed(false);
              revealName();
            }}
            onClick={(event) => {
              if (unavailable) return;
              setPreviewDismissed(true);
              onPreviewChange(false);
              const losesFocus =
                mine &&
                authorIds.length === 1 &&
                event.currentTarget === document.activeElement;
              if (toggle(reaction.content, reaction.emoji) && losesFocus)
                onFocusedRemoval?.();
            }}
          >
            <span
              ref={emojiAnchor}
              className={styles.reactionGlyph}
              data-reaction-glyph
              data-grouped={grouped || undefined}
            >
              <ReactionGlyph reaction={reaction} session={session} />
              {grouped && (
                <span className={styles.reactionCount}>{authorIds.length}</span>
              )}
            </span>
          </Button>
        }
      >
        <ReactionPreviewContent
          reaction={reaction}
          authorIds={authorIds}
          session={session}
          profiles={profiles}
          name={name}
          previewTilt={previewTilt}
          peopleList={peopleList}
          overflowing={overflowing}
          onOverflow={setOverflowing}
        />
      </PreviewCard>
    </span>
  );
}

/** Always mounted under the message so failed add/remove operations stay recoverable. */
export function MessageReactions(
  props: Props & {
    onFocusedRemoval?: () => void;
    profiles?: ReadonlyMap<string, Profile>;
  },
) {
  const active = useConversationPresentation();
  const { row, session, scope, tools } = props;
  const action = useReactionAction(props);
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  const [pointerInRow, setPointerInRow] = useState(false);
  const [preview, setPreview] = useState<{
    key: string | null;
    index: number;
    fromIndex: number | undefined;
  }>();
  if (!active && preview) setPreview(undefined);
  if (!active && pointerInRow) setPointerInRow(false);
  const select = (content: string) => {
    return action.toggle(content, catalogEmoji(catalog.entries, content));
  };
  // Count people, not duplicate events. Each emoji shares one control and preview.
  const reactions = useMemo(
    () =>
      row.reactions.map((reaction) => {
        const authorIds = [
          ...new Set(reaction.events.map((event) => event.authorId)),
        ];
        const mine = !!session.viewer && authorIds.includes(session.viewer);
        return { reaction, authorIds, mine };
      }),
    [row.reactions, session.viewer],
  );
  return (
    // biome-ignore lint/a11y/useSemanticElements: This groups reactions, not form fields.
    <div
      className={styles.reactions}
      data-message-reactions={(active && reactions.length > 0) || undefined}
      data-testid="reaction-row"
      data-populated={(active && reactions.length > 0) || undefined}
      role="group"
      aria-label="Reactions"
      onMouseEnter={() => setPointerInRow(true)}
      onMouseLeave={() => {
        setPointerInRow(false);
        setPreview((current) => (current?.key === null ? undefined : current));
      }}
    >
      {active &&
        reactions.map(({ reaction, authorIds, mine }, index) => {
          const key = JSON.stringify([reaction.content, reaction.emoji?.url]);
          const slideFrom =
            preview?.key === key ? preview.fromIndex : preview?.index;
          const previewSlide =
            pointerInRow && slideFrom !== undefined && slideFrom !== index
              ? index > slideFrom
                ? "right"
                : "left"
              : undefined;
          return (
            <ReactionEmoji
              key={key}
              reaction={reaction}
              authorIds={authorIds}
              mine={mine}
              session={session}
              profiles={props.profiles}
              disabled={props.disabled}
              busy={action.busy}
              toggle={action.toggle}
              onFocusedRemoval={props.onFocusedRemoval}
              // Who reacted is a preview (DESIGN.md "Hover timing"): once one is
              // open, moving along the row slides it to the next pill at once.
              previewWarm={pointerInRow && !!preview}
              previewOpen={preview?.key === key}
              previewSlide={previewSlide}
              onPreviewChange={(open) =>
                setPreview((current) =>
                  open
                    ? {
                        key,
                        index,
                        fromIndex:
                          current?.key === key
                            ? current.fromIndex
                            : current?.index,
                      }
                    : current?.key === key
                      ? pointerInRow
                        ? { ...current, key: null }
                        : undefined
                      : current,
                )
              }
            />
          );
        })}
      {active &&
        reactions.length > 0 &&
        row.audience !== "agents" &&
        !props.disabled && (
          <span
            className={`${styles.inlineReactionTool} buzz-compact-controls`}
            data-message-reactions
            data-testid="inline-add-reaction"
          >
            <ReactionTool
              registry={tools}
              session={session}
              scope={scope}
              messageId={row.id}
              disabled={action.disabled}
              select={select}
              showDelivery={false}
            />
          </span>
        )}
      {action.error && <span role="alert">{action.error}</span>}
      <ReactionDelivery session={session} messageId={row.id} />
    </div>
  );
}
